# dsh-ttsr — Time-Traveling Stream Rules for the DeepSeek Harness

A port of [omp's TTSR](https://github.com/can1357/oh-my-pi) (feature #04) to DSH: dormant rules that
watch the model's output stream (prose, reasoning, and tool-call arguments), abort a violating
attempt **mid-token**, inject the matched rule as a reminder, and **retry the same step** as if the
violation never happened. Rules sit dormant until violated — no context tax on clean turns.

## Trigger types

| Trigger | Fires where | Semantics |
| --- | --- | --- |
| `condition` | streaming (`llm/stream`) | JavaScript regex over the raw output text / tool-call argument JSON. Matching aborts the attempt mid-token, injects the reminder, and retries the same step. |
| `astCondition` | `tools/pre-execute` | A structural code pattern with metavariables, matched against the code `edit`/`write` tools produce (`new_string` / `content`). A match **denies the call before side effects** (`Blocked by stream rule …`) and injects the reminder for the retried rewrite. |
| `question` | after `assistant/message` commits | A yes/no question sent to a judge model (the session's own route, or the `generator` override). Answers with yes + confidence ≥ 0.7 deliver the reminder as an aside — next step when the agent is running, a new turn when idle. Costs one extra model call per judged output. |

A rule may combine `condition` + `astCondition` (omp parity: the regex keeps working on every
scope, the pattern applies to tool streams). Rules must declare at least one trigger.

`astCondition` patterns are code snippets with metavariables — `console.log($$$ARGS)` matches any
`console.log` call; `let $X = $X + 1` matches self-assignment. Matching is token-structural: it is
whitespace-insensitive and enforces metavariable unification, but (unlike ast-grep with a real
parser) it cannot respect statement boundaries. Patterns are only evaluated against sources whose
file extension marks them as code.

`globs` restrict a rule's tool-scope matching to candidate file paths (`*.ts`, `src/**/*.{py}`
style: `*`/`?` within a segment, a `**` segment matches zero or more whole segments; tested
against the full path and the basename).

## How the time travel works

```
model stream ──▶ llm/stream waterfall (this plugin)
                   │  regex match in text / reasoning / tool-call args
                   ├─▶ stop forwarding, yield synthetic finish
                   │     {kind:'error', code:'TTSR_INTERRUPT'}      ──▶ loop settles the partial
                   │                                                    as log-only assistant/attempt
                   │                                                    (discarded from model history,
                   │                                                    durably recorded for the UI)
                   ▼
           agent/request-error waterfall (this plugin)
                   ├─ append llm/retry + llm/retry-started          ──▶ renders the stock
                   │                                                    "Retried model request" row
                   ├─ append user/message reminder (surface append)   ──▶ renders the amber
                   │                                                    "Stream rule injected" card
                   └─ return {kind:'retry'}                           ──▶ same turn + step re-runs,
                                                         request re-derived from the log with
                                                         the reminder as the last message
```

The loop re-derives every request from the committed session surface, so the retry "time travels":
the violating attempt never becomes model-visible, and the rule text rides the retry.

## UX surfaces

- **Amber "Stream rule injected" card** in the chat timeline (rule name, matched excerpt, rule
  message, retry note) — a custom conversation node (`dsh-ttsr-reminder`) claimed exclusively from
  the `dsh-ttsr:reminder` surface message; durable across reload, fork, and paging.
- **"Retried model request (n/max)" row** — the stock model-retry UI, driven by this plugin's
  `llm/retry` / `llm/retry-started` events with `policyKey: ttsr`.
- **Observe-only rules** (`interruptMode: never`, and prose-only/tool-only rules matching out of
  mode) inject the reminder passively without aborting: tool-source matches attach to the tool
  result via `tools/post-execute` `additionalContexts`; prose matches steer the next step.

## Commands

| Command | What it does |
| --- | --- |
| `/omfg <description>` | Generates rule candidates with the session's model (route taken from the last assistant message, or the `generator` config), validates each regex (must compile, must not match the empty string), counts matches against recent assistant output, then shows a **native multi-select confirm card**. Selected rules are persisted through `configEditor` into the user's `cordis.patch.yml` patch layer and the rulebook reloads live. |
| `/ttsr` | Lists rules with scope/interrupt/repeat settings and enabled state. |
| `/ttsr test <regex>` | Counts matches of a regex across this session's assistant text and tool-call arguments. |
| `/ttsr forget <name>` | Removes a rule (persisted through `configEditor`). |
| `/ttsr on` / `/ttsr off` | Enables/disables monitoring (persisted). |

## Configuration (profile `cordis.patch.yml`, row `dsh-ttsr`)

```yaml
- id: dsh-ttsr
  name: "@local/dsh-ttsr"
  config:
    enabled: true            # default true
    maxRetriesPerStep: 2      # TTSR retries allowed per step (safety cap)
    retryDelayMs: 250         # delay between abort and retry
    generator:               # optional override for /omfg + judge model route
      provider: wandb
      model: zai-org/GLM-5.3
    rules:
      - name: box-leak                  # [a-zA-Z0-9][a-zA-Z0-9._-]*, unique
        condition: Box::leak             # regex trigger (optional with astCondition/question)
        astCondition: Box::leak($$$)     # structural trigger (optional; edit/write content)
        question: Does this output leak memory?  # judged trigger (optional)
        message: Do not use Box::leak... # imperative instruction injected on match
        scope: [text, tool]              # text | reasoning | tool (default [text, tool])
        tools: [write, edit]             # limit tool matching to these tool names (default all)
        globs: ["src/**/*.rs"]           # limit tool matching to these paths (default all)
        interruptMode: always            # always | never | prose-only | tool-only
        repeatMode: once                 # once | always | after-gap
        repeatGap: 10                    # completed turns for after-gap
```

## Repeat policies

- `once` — the rule fires once per session (in-process state plus a durable session projection
  folding `dsh-ttsr:reminder` surface messages, so suppression survives reload and restart).
- `always` — every match interrupts (bounded by `maxRetriesPerStep` per step).
- `after-gap` — re-fires after N completed turns.

## Files

- `index.js` — Host plugin: rulebook (config-validated), the `llm/stream` monitor with
  growth-throttled incremental regex scans and glob-gated tool streams, the synthetic-finish abort,
  the `agent/request-error` recovery (retry cap, `llm/retry` events, reminder append), the
  `tools/pre-execute` AST gate (deny before side effects), the question-judging engine
  (post-commit judge calls with aside delivery), passive delivery paths, the `sessionProjections`
  unit (`key: ttsr`), and the `/omfg` + `/ttsr` commands.
- `ast-matcher.js` — the structural pattern engine (tokenizer, metavariable unification, glob
  compiler, tool-arg source extraction) with `ast-matcher.test.js` unit tests.
- `client.js` — browser half: the `dsh-ttsr-reminder` conversation event definition (exclusive
  claim of `dsh-ttsr:reminder` appends) and the amber card renderer in `conversation.chat.node`.
- `locale/en.json` — plugin manager metadata. `icon.svg` — original artwork.

## Install

Lives in the `ds-harness` plugin collection (`C:\Users\babys\OneDrive\文件\ds-harness\dsh-ttsr`)
and is installed as a linked local bundle in the `desktop` profile via
`plugin_manager install_bundle` with this directory. Because it is a linked checkout, edits to
these files are live after `remove_bundle` + `install_bundle`. Dependencies
(`@deepseek-ai/schemastery` 3.18.5, matching the runtime) are installed with
`npm install --prefix <this directory>` — plain hoisted `node_modules`, which also survives
OneDrive sync (pnpm's symlinked layout does not, and pnpm resolves the home workspace root from
this path, so use npm here).
