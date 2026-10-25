# Judge performance on CPU — measured findings

All numbers measured on a Ryzen 7 6800H (8C/16T), qev-0.8b Q8_0,
llama.cpp b11827 win-cpu-x64 (haswell/AVX2 backend), Windows, while
DSH + Chrome were running. Calibration gate: `scripts/verify-judge.mjs`.

## Baseline (why it's slow)

Qwen3.5 is a hybrid architecture: linear-attention (recurrent) layers
must be evaluated token-by-token, so prompt eval cannot be fully
batched the way a plain transformer's can. llama.cpp marks the arch
`is_hybrid` with `rs_rollback` support. This is an architectural cost,
not a config error — verified: full affinity, correct DLL, correct
thread detection, thread scaling works (44.7 → 134 → 190 → 235 tok/s
for 1/4/8/16 threads on pp2048).

## Levers applied

| Lever | Effect | Status |
|---|---|---|
| `-c 16384` (model trains to 256k) | headroom, no per-request cost | live |
| `--threads 16` | 190 → 235 tok/s (+24%) | live |
| Path-sized windows (8k interrupt / 24k async) | bounded blocking cost | live |

Measured end-to-end at 16 threads, Q8_0: ~2k-token state ≈ 4 s;
~9k-token state ≈ 15 s; ~40k-token state ≈ 74 s. Marginal rate
~2.2 ms/token.

## Levers measured and rejected

**Q4_K_M requantize (from Q8_0):** 339 tok/s at 16 threads (+78%),
but the calibration harness fails — long-context tail violation drops
0.66 → 0.30 (missed entirely), gray case shifts 0.68 → 0.87 (over-fires).
Double quantization (Q8→Q4) wrecks the marginal probabilities the
three-band gate depends on. A from-BF16 Q4 could be retested, but the
evidence says the judge is quant-sensitive; Q8_0 stays.

**`--cache-ram` prefix cache:** units are MiB (default 0 = disabled
for decision models). With `--cache-ram 1024` the cache allocates, but
decision tasks hard-set `cache_prompt = false` in llama.cpp's
task filler, so even byte-identical repeat requests re-evaluate the
full prompt. Not usable without a patch.

## Remaining engineering (requires building llama.cpp)

1. **Prompt caching for decision tasks** — remove/flag the
   `cache_prompt = false` assignment in the decision task filler.
   The cache machinery, unified-KV idle-slot saving, and qwen35's
   bounded `rs_rollback` (prefix reuse for recurrent models) already
   exist upstream. Mid-stream re-verifications of a growing output
   would pay delta-only instead of full prompt cost.
2. **Chunked scan for the linear-attention layers on CPU** — the CUDA
   path computes these layers chunked (batched intra-chunk GEMMs,
   sequential per-chunk state combination); the CPU path is naive
   per-token. Porting the chunked formulation to CPU ggml is the
   deep fix (expected 5–20x on pp for this arch) and upstreamable.

Alternative escape hatch (not CPU engineering): offload the 0.8B judge
to GPU (~1 GB VRAM at Q8_0) — CUDA linear-attention kernels are
already chunked; a 16k-token judgment drops to ~1–2 s.
