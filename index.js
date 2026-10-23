// ============================================================================
// @local/dsh-ttsr — Time-Traveling Stream Rules for the DeepSeek Harness
//
// Dormant regex rules that watch the assistant's output stream (prose,
// reasoning, and tool-call arguments). When a rule matches:
//   1. the model attempt is ended with a synthetic TTSR_INTERRUPT failure
//      (the partial output is recorded as a log-only `assistant/attempt`
//      and never enters model-visible history — "discard"),
//   2. the matched rule is appended to the conversation surface as a
//      plugin-attributed user-role reminder (`dsh-ttsr:reminder`),
//   3. the same step is retried — the loop re-derives its request from the
//      session log, so the reminder rides the retry ("time travel").
//
// Rules sit dormant until violated: no context tax on clean turns.
// `/omfg` generates rules from the conversation; `/ttsr` manages them.
// ============================================================================

import { randomUUID } from "node:crypto";
import z from "@deepseek-ai/schemastery";
import {
  compilePattern,
  extractSources,
  globToRegExp,
  hasCodeExtension,
  matchTokens,
  matchesGlobs,
  pathFromPartialJson,
  tokenize,
} from "./ast-matcher.js";

const name = "dsh-ttsr";
const inject = ["commands", "userQuestions", "sessionProjections", "agents"];

const FAILURE_CODE = "TTSR_INTERRUPT";
const REMINDER_SOURCE = "dsh-ttsr:reminder";
const PANEL_PREFIX = "TTSR-PANEL ";
const SET_PREFIX = "TTSR-SET ";
const INTERNAL_REQUESTS = new WeakSet();
const FULL_SCAN_LIMIT = 4096;
const SCOPE_VALUES = ["text", "reasoning", "tool"];
const INTERRUPT_VALUES = ["always", "never", "prose-only", "tool-only"];
const REPEAT_VALUES = ["once", "always", "after-gap"];

// ---------------------------------------------------------------------------
// Configuration (Loader-validated; re-validated fail-loud in apply)
// ---------------------------------------------------------------------------

const Config = z.object({
  enabled: z.boolean().default(true),
  maxRetriesPerStep: z.number().default(2),
  retryDelayMs: z.number().default(250),
  monitorSubagents: z.boolean().default(false),
  judge: z.object({
    kind: z.string(),
    baseUrl: z.string(),
    threshold: z.number(),
    launch: z.object({
      command: z.string().required(),
      args: z.array(z.string()).default([]),
      cwd: z.string(),
    }),
  }),
  generator: z.object({
    provider: z.string(),
    model: z.string(),
  }),
  rules: z
    .array(
      z.object({
        name: z.string().required(),
        condition: z.string(),
        astCondition: z.string(),
        question: z.string(),
        message: z.string().required(),
        scope: z.array(z.string()).default(["text", "tool"]),
        tools: z.array(z.string()).default([]),
        globs: z.array(z.string()).default([]),
        interruptMode: z.string().default("always"),
        repeatMode: z.string().default("once"),
        repeatGap: z.number().default(10),
      }),
    )
    .default([]),
});

function warnOnce(logger, key, text) {
  try {
    logger.warn(`dsh-ttsr: ${text}`);
  } catch {}
}

function compileRule(raw, logger) {
  if (raw === null || typeof raw !== "object") return null;
  const label = typeof raw.name === "string" && raw.name.length > 0 ? raw.name : "<unnamed>";
  if (typeof raw.name !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(raw.name)) {
    warnOnce(logger, label, `rule "${label}" skipped: name must match [a-zA-Z0-9][a-zA-Z0-9._-]*`);
    return null;
  }
  const hasCondition = typeof raw.condition === "string" && raw.condition.length > 0;
  const hasAst = typeof raw.astCondition === "string" && raw.astCondition.trim().length > 0;
  const hasQuestion = typeof raw.question === "string" && raw.question.trim().length > 0;
  if (!hasCondition && !hasAst && !hasQuestion) {
    warnOnce(logger, raw.name, `rule "${raw.name}" skipped: needs at least one of condition, astCondition, or question`);
    return null;
  }
  let regex = null;
  if (hasCondition) {
    try {
      regex = new RegExp(raw.condition, "m");
    } catch (error) {
      warnOnce(logger, raw.name, `rule "${raw.name}" skipped: condition does not compile: ${error.message}`);
      return null;
    }
  }
  let astItems = null;
  if (hasAst) {
    const compiled = compilePattern(raw.astCondition);
    if (!compiled.ok) {
      warnOnce(logger, raw.name, `rule "${raw.name}" skipped: astCondition invalid: ${compiled.error}`);
      return null;
    }
    astItems = compiled.items;
  }
  let message = typeof raw.message === "string" && raw.message.trim().length > 0 ? raw.message.trim() : null;
  if (message === null) {
    warnOnce(logger, raw.name, `rule "${raw.name}" skipped: message must be a non-empty instruction`);
    return null;
  }
  const scopeRaw = Array.isArray(raw.scope) && raw.scope.length > 0 ? raw.scope : hasQuestion ? ["text"] : ["text", "tool"];
  const scope = scopeRaw.filter((entry) => SCOPE_VALUES.includes(entry));
  if (scope.length === 0) {
    warnOnce(logger, raw.name, `rule "${raw.name}" skipped: scope must contain text, reasoning, or tool`);
    return null;
  }
  const interruptMode = INTERRUPT_VALUES.includes(raw.interruptMode) ? raw.interruptMode : "always";
  const repeatMode = REPEAT_VALUES.includes(raw.repeatMode) ? raw.repeatMode : "once";
  const repeatGap = Number.isInteger(raw.repeatGap) && raw.repeatGap > 0 ? raw.repeatGap : 10;
  const tools = Array.isArray(raw.tools)
    ? raw.tools.filter((entry) => typeof entry === "string" && entry.length > 0)
    : [];
  const globs = Array.isArray(raw.globs)
    ? raw.globs.filter((entry) => typeof entry === "string" && entry.length > 0)
    : [];
  const globsRegexes = globs.map((glob) => {
    try {
      return globToRegExp(glob);
    } catch {
      return null;
    }
  });
  return {
    name: raw.name,
    condition: hasCondition ? raw.condition : undefined,
    astCondition: hasAst ? raw.astCondition : undefined,
    question: hasQuestion ? raw.question.trim() : undefined,
    message,
    scope,
    tools,
    globs,
    globsRegexes: globsRegexes.filter((entry) => entry !== null),
    interruptMode,
    repeatMode,
    repeatGap,
    regex,
    astItems,
    canText: scope.includes("text"),
    canReasoning: scope.includes("reasoning"),
    canTool: scope.includes("tool"),
  };
}

function resolveSettings(config, logger) {
  const value = config ?? {};
  const enabled = value.enabled !== false;
  const maxRetriesPerStep = Number.isInteger(value.maxRetriesPerStep) && value.maxRetriesPerStep >= 0 ? value.maxRetriesPerStep : 2;
  const retryDelayMs = Number.isInteger(value.retryDelayMs) && value.retryDelayMs >= 0 && value.retryDelayMs <= 60000 ? value.retryDelayMs : 250;
  const generator =
    typeof value.generator?.provider === "string" &&
    typeof value.generator?.model === "string" &&
    value.generator.provider.length > 0 &&
    value.generator.model.length > 0
      ? { provider: value.generator.provider, model: value.generator.model }
      : undefined;
  const rawJudge = value.judge ?? {};
  const judge = {
    kind: rawJudge.kind === "qev" ? "qev" : "chat",
    baseUrl: typeof rawJudge.baseUrl === "string" && rawJudge.baseUrl.length > 0 ? rawJudge.baseUrl : "http://127.0.0.1:8790",
    threshold: Number.isFinite(rawJudge.threshold) && rawJudge.threshold > 0.5 && rawJudge.threshold < 1 ? rawJudge.threshold : 0.7,
    launch:
      typeof rawJudge.launch?.command === "string" && rawJudge.launch.command.length > 0
        ? {
            command: rawJudge.launch.command,
            args: Array.isArray(rawJudge.launch.args) ? rawJudge.launch.args.filter((entry) => typeof entry === "string") : [],
            ...(typeof rawJudge.launch.cwd === "string" && rawJudge.launch.cwd.length > 0 ? { cwd: rawJudge.launch.cwd } : {}),
          }
        : undefined,
  };
  const rules = [];
  const seen = new Set();
  for (const raw of Array.isArray(value.rules) ? value.rules : []) {
    const rule = compileRule(raw, logger);
    if (rule === null) continue;
    if (seen.has(rule.name)) {
      warnOnce(logger, rule.name, `rule "${rule.name}" skipped: duplicate name`);
      continue;
    }
    seen.add(rule.name);
    rules.push(rule);
  }
  return { enabled, maxRetriesPerStep, retryDelayMs, generator, judge, monitorSubagents: value.monitorSubagents === true, rules };
}

// ---------------------------------------------------------------------------
// Message helpers (no cross-package imports: shapes match dsh-llm exactly)
// ---------------------------------------------------------------------------

const XML_AMP = String.fromCharCode(38) + "amp;";
const XML_LT = String.fromCharCode(38) + "lt;";
const XML_GT = String.fromCharCode(38) + "gt;";
const XML_QUOT = String.fromCharCode(38) + "quot;";
const XML_ESCAPES = { "&": XML_AMP, "<": XML_LT, ">": XML_GT, '"': XML_QUOT };

function escapeXml(text) {
  return text.replace(/[&<>"]/g, (ch) => XML_ESCAPES[ch]);
}

function excerptAround(text, index, radius = 60) {
  const start = Math.max(0, index - radius);
  const end = Math.min(text.length, index + radius);
  return `${start > 0 ? "…" : ""}${text.slice(start, end).replace(/\s+/g, " ").trim()}${end < text.length ? "…" : ""}`;
}

function reminderMessage(violations, mode = "interrupt") {
  const envelopes = violations.map(
    (violation) =>
      `<system-interrupt reason="rule_violation" rule="${escapeXml(violation.rule.name)}"${
        violation.excerpt !== undefined ? ` matched="${escapeXml(violation.excerpt)}"` : ""
      }>\n${violation.rule.message}\n</system-interrupt>`,
  );
  const intro =
    mode === "observe"
      ? "A time-traveling stream rule matched while the response was being written. The output was not interrupted; this reminder is injected so the next step complies. Follow every rule below strictly."
      : "A time-traveling stream rule matched while the previous response was being written. That attempt was discarded; this reminder was spliced in and the step is being retried. Follow every rule below strictly.";
  const text = [intro, "", ...envelopes].join("\n");
  return {
    id: randomUUID(),
    role: "user",
    content: [{ type: "text", text }],
    source: {
      kind: REMINDER_SOURCE,
      form: "notice",
      summary: `ttsr: ${violations.map((violation) => violation.rule.name).join(", ")}`.slice(0, 120),
      rules: violations.map((violation) => violation.rule.name),
      mode,
    },
  };
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

// Per-session live state (module scope so the command handlers can reach it).
// Derived cache; the session log is the truth. Entries are cleaned on agent
// disposal and re-created on demand.
const live = new Map();

function stateOf(sessionId) {
  let state = live.get(sessionId);
  if (state === undefined) {
    state = {
      pending: null, // { nonce, violations } awaiting the request-error retry
      stepRetries: new Map(), // "turn:step" -> count
      currentStepKey: "",
      currentTurn: 0,
      injected: new Set(), // rule names injected in this process
      injectedAtTurn: new Map(), // rule name -> turn number at injection
      passiveTools: new Map(), // `${sessionId}:${callId}` -> reminder message
      passiveProse: null, // reminder message to steer after a clean finish
      broken: false, // monitor health for this session
      astDenies: 0, // AST denials since the last assistant message
      judged: new Set(), // assistant message ids already judged
      judgmentBusy: false, // one judge batch at a time per session
      judgmentQueue: [],
      disabled: new Set(), // rule names muted for this session only (config untouched)
      verifiedNo: new Map(), // rule name -> buffer length at its last not-a-violation verdict
    };
    live.set(sessionId, state);
  }
  return state;
}

function apply(ctx, config = {}) {
  const settings = resolveSettings(config, ctx.logger ?? console);
  const rules = settings.rules;
  const rulesByName = new Map(rules.map((rule) => [rule.name, rule]));
  const astRules = rules.filter((rule) => rule.astItems !== null);
  const questionRules = rules.filter((rule) => rule.question !== undefined);

  function readProjection(session) {
    try {
      const state = ctx.sessionProjections.stateOf(session, "ttsr");
      if (state !== null && typeof state === "object") {
        const mutes =
          state.mutes !== null && typeof state.mutes === "object" && !Array.isArray(state.mutes) ? state.mutes : null;
        return {
          injectedRules: Array.isArray(state.injectedRules) ? state.injectedRules.filter((entry) => typeof entry === "string") : [],
          completedTurns: Number.isInteger(state.completedTurns) ? state.completedTurns : 0,
          mutes,
        };
      }
    } catch {}
    return null;
  }

  /** Restore a session's mute set from the durable marker projection. */
  function syncDisabled(state, session) {
    if (session === undefined) return;
    const projected = readProjection(session);
    const mutes = projected?.mutes;
    if (mutes === null || mutes === undefined) return; // no markers yet — keep live state
    state.disabled = new Set(Object.keys(mutes).filter((name) => mutes[name] === true));
  }

  /** Full snapshot of this session's rule states for panels and markers. */
  function ruleSnapshot(state) {
    return rules.map((rule) => ({
      name: rule.name,
      muted: state.disabled.has(rule.name),
      trigger:
        rule.regex !== null
          ? `/${rule.condition}/`
          : rule.astItems !== null
            ? `ast: ${rule.astCondition}`
            : `judge: ${rule.question.slice(0, 90)}`,
    }));
  }

  /** Apply a mute change to live state. Durable state derives from the
   *  ttsr-set command events themselves (their command/done results carry the
   *  full rule snapshot); no session events are appended here. Appending
   *  novel user/message shapes poisons the live session (v4 rejects them). */
  function applyMutes(agent, nextDisabled) {
    const state = stateOf(agent.id);
    state.disabled = nextDisabled;
  }

  /** Mark a rule injected, recording the turn it fired at for after-gap repeats. */
  function markInjected(state, ruleName, turn) {
    state.injected.add(ruleName);
    state.injectedAtTurn.set(ruleName, Number.isInteger(turn) ? turn : (state.currentTurn ?? 0));
  }

  /** Whether a session's stream should be monitored: root agents only unless configured. */
  function isMonitoredSession(sessionId) {
    if (settings.monitorSubagents) return true;
    try {
      const agent = ctx.agents.get(sessionId);
      if (agent === undefined) return true; // unknown live session: monitor rather than miss
      return ctx.agents.roots().includes(agent);
    } catch {
      return true;
    }
  }

  // ---- qev decision server (CPU llama-server behind /v1/systemone) ----------
  let qevProcess = null;
  ctx.effect(() => () => {
    try {
      qevProcess?.kill();
    } catch {}
    qevProcess = null;
  }, "dsh-ttsr: qev judge server");

  async function qevHealthy(baseUrl) {
    try {
      const response = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(1500) });
      return response.ok;
    } catch {
      return false;
    }
  }

  async function waitForQev(baseUrl, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await qevHealthy(baseUrl)) return true;
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
    return false;
  }

  async function ensureQev() {
    const baseUrl = settings.judge.baseUrl;
    if (await qevHealthy(baseUrl)) return baseUrl;
    const launch = settings.judge.launch;
    if (launch === undefined) return baseUrl; // externally managed
    if (qevProcess !== null && qevProcess.exitCode === null) {
      await waitForQev(baseUrl, 60000);
      return baseUrl;
    }
    try {
      const { spawn } = await import("node:child_process");
      qevProcess = spawn(launch.command, launch.args, {
        ...(launch.cwd !== undefined ? { cwd: launch.cwd } : {}),
        stdio: "ignore",
        windowsHide: true,
      });
      qevProcess.on("exit", () => {
        qevProcess = null;
      });
    } catch (error) {
      warnOnce(ctx.logger ?? console, "qev", `could not spawn the judge server: ${error.message}`);
      return baseUrl;
    }
    await waitForQev(baseUrl, 90000);
    return baseUrl;
  }

  async function qevDecide(baseUrl, state, questions) {
    const response = await fetch(`${baseUrl}/v1/systemone`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ state, questions }),
      signal: AbortSignal.timeout(45000),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json();
    return payload?.answers ?? {};
  }

  // ---- durable repeat state, derived from the session log ----
  try {
    ctx.sessionProjections.register({
      key: "ttsr",
      stateVersion: 2,
      stateSchema: z.object({
        injectedRules: z.array(z.string()),
        completedTurns: z.number(),
        mutes: z.object(z.string(), z.boolean()),
      }),
      init: () => ({ injectedRules: [], completedTurns: 0, mutes: {} }),
      apply: (state, event) => {
        if (event.type === "turn/end") return { injectedRules: state.injectedRules, completedTurns: state.completedTurns + 1, mutes: state.mutes };
        if (event.type === "command/done") {
          // Mute snapshots ride on ttsr-set / panel command results — existing,
          // legal event types — instead of novel marker events.
          const text = String(event.data?.text ?? "");
          if (text.startsWith(SET_PREFIX) || text.startsWith(PANEL_PREFIX)) {
            try {
              const parsed = JSON.parse(text.slice(text.indexOf("{")));
              if (Array.isArray(parsed?.rules)) {
                const mutes = {};
                for (const rule of parsed.rules) if (rule !== null && typeof rule.name === "string") mutes[rule.name] = rule.muted === true;
                return { injectedRules: state.injectedRules, completedTurns: state.completedTurns, mutes };
              }
            } catch {}
          }
          return state;
        }
        if (event.type !== "user/message") return state;
        const source = event.data?.source;
        if (source?.kind !== REMINDER_SOURCE) return state;
        const names = Array.isArray(source.rules) ? source.rules.filter((entry) => typeof entry === "string") : [];
        if (names.length === 0) return state;
        let changed = false;
        const merged = new Set(state.injectedRules);
        for (const ruleName of names) {
          if (!merged.has(ruleName)) {
            merged.add(ruleName);
            changed = true;
          }
        }
        return changed ? { injectedRules: [...merged], completedTurns: state.completedTurns, mutes: state.mutes } : state;
      },
    });
  } catch (error) {
    warnOnce(ctx.logger ?? console, "projection", `session projection unavailable (${error.message}); repeat state resets on reload`);
  }

  ctx.on("agent/disposed", ({ agent }) => live.delete(agent.id));

  ctx.on("session/event", (session, event) => {
    if (event.type === "step/start") {
      const state = live.get(session.id);
      if (state !== undefined && Number.isInteger(event.data?.turn) && Number.isInteger(event.data?.step)) {
        state.currentStepKey = `${event.data.turn}:${event.data.step}`;
      }
      return;
    }
    if (event.type === "turn/start") {
      const state = live.get(session.id);
      if (state !== undefined && Number.isInteger(event.data?.turn)) state.currentTurn = event.data.turn;
      return;
    }
    if (event.type === "assistant/message") {
      const state = live.get(session.id);
      if (state !== undefined) state.astDenies = 0;
      if (settings.enabled && questionRules.length > 0 && event.data?.message?.content !== undefined && isMonitoredSession(session.id)) {
        queueJudgment(session, event.data.message);
      }
    }
  });

  // ---- repeat policy -------------------------------------------------------
  function repeatAllows(state, session, rule) {
    if (rule.repeatMode === "always") return true;
    let injected = state.injected.has(rule.name);
    let injectedAtTurn = state.injectedAtTurn.get(rule.name);
    let completedTurns = 0;
    if (!injected && session !== undefined) {
      const projected = readProjection(session);
      if (projected !== null) injected = projected.injectedRules.includes(rule.name);
    }
    if (!injected) return true;
    if (rule.repeatMode === "once") return false;
    if (session !== undefined) {
      const projected = readProjection(session);
      if (projected !== null) completedTurns = projected.completedTurns;
    }
    return completedTurns >= (injectedAtTurn ?? 0) + rule.repeatGap;
  }

  // ---- retry cap -----------------------------------------------------------
  function retriesExhausted(state) {
    return (state.stepRetries.get(state.currentStepKey) ?? 0) >= settings.maxRetriesPerStep;
  }

  // ---- stream monitor ------------------------------------------------------
  function checkBuffer(entry, source, state, session) {
    syncDisabled(state, session);
    for (const rule of rules) {
      if (state.disabled.has(rule.name)) continue; // muted for this session
      if (rule.regex === null) continue; // astCondition/question triggers never fire here
      const scopeOk =
        (source === "text" && rule.canText) ||
        (source === "reasoning" && rule.canReasoning) ||
        (source === "tool" && rule.canTool && (rule.tools.length === 0 || (entry.toolName !== null && rule.tools.includes(entry.toolName))));
      if (!scopeOk) continue;
      if (rule.globsRegexes.length > 0) {
        // A path-gated rule only matches tool streams whose candidate file path passes a glob.
        if (source !== "tool" || entry.path === null || !matchesGlobs(rule.globsRegexes, entry.path)) continue;
      }
      if (!repeatAllows(state, session, rule)) continue;
      const length = entry.text.length;
      if (length === 0) continue;
      if (length <= FULL_SCAN_LIMIT || length >= (entry.lastScan ?? 0) * 1.25) {
        entry.lastScan = length;
        const match = rule.regex.exec(entry.text);
        if (match !== null) {
          return { rule, source, excerpt: excerptAround(entry.text, match.index) };
        }
      }
    }
    return null;
  }

  function sourceForChunk(chunk, entry) {
    if (chunk.type === "text-delta") return "text";
    if (chunk.type === "reasoning-delta") return "reasoning";
    if (chunk.type === "tool-call-delta") return "tool";
    if (chunk.type === "block-end") {
      if (chunk.block?.type === "text") return "text";
      if (chunk.block?.type === "reasoning") return "reasoning";
      if (chunk.block?.type === "tool-call") return "tool";
    }
    return null;
  }

  function interruptAllowed(rule, source) {
    if (rule.interruptMode === "always") return true;
    if (rule.interruptMode === "never") return false;
    if (rule.interruptMode === "prose-only") return source === "text" || source === "reasoning";
    if (rule.interruptMode === "tool-only") return source === "tool";
    return true;
  }

  /**
   * Detection -> decision -> execution: a pattern match pauses the stream and
   * asks the decision model whether this is the assistant genuinely violating
   * the rule — as opposed to quoting rule text, discussing rules, or legitimate
   * technical analysis of the pattern's subject. Only a confirmed violation
   * interrupts. When no decision model is configured, matches fire directly.
   */
  async function verifyViolation(match, entry, source, state, session, sessionId) {
    if (settings.judge.kind !== "qev") return true;
    const lastNo = state.verifiedNo.get(match.rule.name) ?? Number.NEGATIVE_INFINITY;
    if (entry.text.length - lastNo < 512) return false; // recently judged not-a-violation
    let agent;
    try {
      agent = ctx.agents.get(sessionId);
    } catch {
      agent = undefined;
    }
    const userRequest = agent !== undefined ? lastUserRequest(agent) : null;
    state.verifiedNo.set(match.rule.name, entry.text.length);
    try {
      const baseUrl = await ensureQev();
      const decisionState = {
        rule_name: match.rule.name,
        rule_intent: match.rule.message,
        pattern: match.rule.condition ?? "",
        matched_text: match.excerpt ?? "",
        output_kind: source,
        output_context: truncateMiddle(entry.text, 3000),
        user_request: userRequest ?? "(the user's request is not available)",
      };
      const answers = await qevDecide(baseUrl, decisionState, {
        decision: {
          type: "noul",
          instructions:
            "The assistant's output matched the rule's pattern. Is this the assistant itself VIOLATING the rule's intent — not quoting rule/config/log text, not discussing or analyzing rules, and not legitimate technical discussion of the pattern's subject?",
        },
      });
      const noul = answers.decision?.noul;
      if (typeof noul !== "number") return true; // unparseable verdict: fire
      if (noul < settings.judge.threshold) {
        warnOnce(ctx.logger ?? console, "verify", `qev cleared a match of "${match.rule.name}" (noul ${noul.toFixed(2)})`);
        return false;
      }
      return true;
    } catch (error) {
      warnOnce(ctx.logger ?? console, "verify", `decision unavailable (${error.message}); firing the match`);
      return true;
    }
  }

  ctx.on("llm/stream", (options, next) => {
    if (!settings.enabled || rules.length === 0) return next();
    if (options.purpose !== undefined || options.sessionId === undefined) return next();
    if (INTERNAL_REQUESTS.has(options)) return next();
    if (!isMonitoredSession(options.sessionId)) return next();
    return monitoredStream(options, next);
  });

  function monitoredStream(options, next) {
    const sessionId = options.sessionId;
    const state = stateOf(sessionId);
    const buffers = new Map();
    const session = (() => {
      try {
        return ctx.agents.get(sessionId)?.session;
      } catch {
        return undefined;
      }
    })();

    function entry(index) {
      let entry = buffers.get(index);
      if (entry === undefined) {
        entry = { text: "", toolName: null, callId: null, path: null, lastScan: 0 };
        buffers.set(index, entry);
      }
      return entry;
    }

    async function* run() {
      let violation = null;
      let passiveProseViolation = null;
      monitor: for await (const chunk of next()) {
        if (!state.broken) {
          try {
            const current = entry(chunk.index ?? 0);
            if (chunk.type === "text-delta") {
              current.text += chunk.text;
            } else if (chunk.type === "reasoning-delta") {
              current.text += chunk.text;
            } else if (chunk.type === "tool-call-delta") {
              if (chunk.name !== undefined) current.toolName = chunk.name;
              if (chunk.id !== undefined) current.callId = chunk.id;
              current.text += chunk.argumentsDelta;
              if (current.path === null) current.path = pathFromPartialJson(current.text);
            } else if (chunk.type === "block-end") {
              const block = chunk.block;
              if (block?.type === "text" || block?.type === "reasoning") {
                current.text = block.text;
              } else if (block?.type === "tool-call") {
                current.toolName = block.name;
                current.callId = block.id;
                current.text = block.arguments;
                if (current.path === null) current.path = pathFromPartialJson(block.arguments);
              }
            } else if (chunk.type === "finish") {
              // Clean finish: deliver a deferred prose reminder for observe-only rules.
              if (passiveProseViolation !== null) {
                const agent = (() => {
                  try {
                    return ctx.agents.get(sessionId);
                  } catch {
                    return undefined;
                  }
                })();
                if (agent !== undefined) {
                  try {
                    agent.steer(reminderMessage([passiveProseViolation], "observe"));
                  } catch (error) {
                    warnOnce(ctx.logger ?? console, "steer", `passive reminder failed: ${error.message}`);
                  }
                }
              }
              yield chunk;
              return;
            }

            const source = sourceForChunk(chunk, current);
            if (source !== null) {
              const match = checkBuffer(current, source, state, session);
              if (match !== null) {
                const canInterrupt = interruptAllowed(match.rule, source);
                if (canInterrupt && !retriesExhausted(state)) {
                  // Detection -> decision -> execution: the pattern only fires
                  // when the decision model confirms a genuine violation.
                  const confirmed = await verifyViolation(match, current, source, state, session, sessionId);
                  if (confirmed) {
                    violation = match;
                    break monitor;
                  }
                  // Verdict: do nothing. The match was quoted text, rule
                  // discussion, or legitimate analysis — the stream continues.
                } else if (!canInterrupt) {
                  // Non-interrupting match (interruptMode "never", or prose-only/tool-only
                  // out of mode): deliver the reminder without aborting the stream.
                  if (source === "tool" && current.callId !== null) {
                    state.passiveTools.set(`${sessionId}:${current.callId}`, reminderMessage([match], "observe"));
                  } else if (source === "text" || source === "reasoning") {
                    passiveProseViolation = match;
                  }
                  markInjected(state, match.rule.name);
                }
                // Interrupt allowed but retries exhausted: stay silent — the rule has
                // already been injected maxRetriesPerStep times for this step.
              }
            }
          } catch (error) {
            state.broken = true;
            warnOnce(ctx.logger ?? console, "monitor", `stream monitor disabled for this stream: ${error.message}`);
          }
        }
        yield chunk;
      }

      if (violation === null) return;
      const nonce = randomUUID().slice(0, 8);
      state.pending = { nonce, violations: [violation] };
      yield {
        type: "finish",
        reason: {
          kind: "error",
          failure: {
            message: `TTSR rule "${violation.rule.name}" matched the output stream [ttsr:${nonce}]`,
            code: FAILURE_CODE,
          },
        },
      };
    }

    return run();
  }

  // =========================================================================
  // astCondition: structural rules checked before a tool call's side effects
  // =========================================================================
  let active = true;
  ctx.effect(() => () => {
    active = false;
  });

  function getLlm() {
    try {
      return ctx.get("llm");
    } catch {
      return undefined;
    }
  }

  function matchAstRules(exec) {
    const agent = exec.agent;
    const session = (() => {
      try {
        return agent.session;
      } catch {
        return undefined;
      }
    })();
    const state = stateOf(agent.id);
    syncDisabled(state, session);
    for (const rule of astRules) {
      if (state.disabled.has(rule.name)) continue; // muted for this session
      if (rule.tools.length > 0 && !rule.tools.includes(exec.name)) continue;
      if (!repeatAllows(state, session, rule)) continue;
      for (const source of extractSources(exec.arguments)) {
        if (!hasCodeExtension(source.path)) continue;
        if (rule.globsRegexes.length > 0 && !matchesGlobs(rule.globsRegexes, source.path)) continue;
        const match = matchTokens(rule.astItems, tokenize(source.content));
        if (match !== null) {
          return { rule, source: source.path, excerpt: match.text };
        }
      }
    }
    return null;
  }

  ctx.on("tools/pre-execute", async (exec, next) => {
    try {
      if (
        settings.enabled &&
        active &&
        astRules.length > 0 &&
        exec.agent !== undefined &&
        isMonitoredSession(exec.agent.id) &&
        exec.arguments !== null &&
        typeof exec.arguments === "object"
      ) {
        const violation = matchAstRules(exec);
        if (violation !== null) {
          const state = stateOf(exec.agent.id);
          const canInterrupt = interruptAllowed(violation.rule, "tool");
          if (canInterrupt && state.astDenies <= settings.maxRetriesPerStep) {
            state.astDenies += 1;
            markInjected(state, violation.rule.name);
            try {
              exec.agent.inject(reminderMessage([violation], "interrupt"));
            } catch (error) {
              warnOnce(ctx.logger ?? console, "ast", `reminder injection failed: ${error.message}`);
            }
            return {
              kind: "deny",
              reason: `Blocked by stream rule "${violation.rule.name}": ${violation.rule.message} The call was stopped before anything changed; rewrite it without the violating construct.`,
              info: { name: "dsh-ttsr", code: "TTSR_RULE", reason: violation.rule.name },
            };
          }
          if (!canInterrupt) {
            markInjected(state, violation.rule.name);
            try {
              exec.agent.inject(reminderMessage([violation], "observe"));
            } catch {}
          }
        }
      }
    } catch (error) {
      warnOnce(ctx.logger ?? console, "ast", `AST gate failed: ${error.message}`);
    }
    return next();
  });

  // =========================================================================
  // question: LLM-judged rules, evaluated after an assistant output commits
  // =========================================================================
  const JUDGE_SYSTEM = "You judge assistant outputs against rules. Be strict: answer yes only when the output clearly violates the question, and report calibrated confidence. Respond only with JSON.";

  function messageOutputs(message) {
    const outputs = [];
    const blocks = Array.isArray(message?.content) ? message.content : [];
    const text = [];
    const reasoning = [];
    let toolCalls = 0;
    for (const block of blocks) {
      if (block?.type === "text" && typeof block.text === "string") text.push(block.text);
      else if (block?.type === "reasoning" && typeof block.text === "string") reasoning.push(block.text);
      else if (block?.type === "tool-call" && typeof block.arguments === "string") {
        toolCalls += 1;
        outputs.push({ kind: "tool", toolName: block.name, path: pathFromPartialJson(block.arguments), content: block.arguments });
      }
    }
    // A message that also dispatches tool calls is acting, not stalling: its
    // prose is a preamble to work already underway, so only the tool outputs
    // are judged. Judging the prose alone flags normal transitional narration.
    const proseIsPreamble = toolCalls > 0;
    const result = [];
    if (text.length > 0 && !proseIsPreamble) result.push({ kind: "text", content: text.join("\n") });
    if (reasoning.length > 0 && !proseIsPreamble) result.push({ kind: "reasoning", content: reasoning.join("\n") });
    result.push(...outputs);
    return result;
  }

  function parseJudgeAnswers(text) {
    const stripped = String(text ?? "").replace(/^```(?:json)?\s*/m, "").replace(/```\s*$/m, "").trim();
    const start = stripped.indexOf("{");
    const end = stripped.lastIndexOf("}");
    if (start < 0 || end <= start) return new Map();
    let parsed;
    try {
      parsed = JSON.parse(stripped.slice(start, end + 1));
    } catch {
      return new Map();
    }
    const list = Array.isArray(parsed?.answers) ? parsed.answers : [];
    const map = new Map();
    for (const entry of list) {
      if (entry === null || typeof entry !== "object" || typeof entry.id !== "string") continue;
      map.set(entry.id, { yes: entry.yes === true, confidence: typeof entry.confidence === "number" ? entry.confidence : 0 });
    }
    return map;
  }

  function truncateMiddle(text, limit) {
    if (text.length <= limit) return text;
    const head = Math.floor(limit * 0.35);
    const tail = limit - head;
    return `${text.slice(0, head)}\n…[middle cut]…\n${text.slice(text.length - tail)}`;
  }

  function lastUserRequest(agent) {
    try {
      const messages = agent.session.deriveMessages();
      for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = messages[index];
        if (message?.role !== "user" || message?.source?.kind !== "user") continue;
        const text = (message.content ?? [])
          .filter((block) => block?.type === "text")
          .map((block) => block.text)
          .join("\n");
        if (text.trim().length === 0) continue;
        return text.length > 1500 ? `${text.slice(0, 1500)}…` : text;
      }
      return null;
    } catch {
      return null;
    }
  }

  async function judgeOutput(session, message, output, candidates, userRequest) {
    if (settings.judge.kind === "qev") {
      try {
        const baseUrl = await ensureQev();
        const questions = {};
        for (const rule of candidates) {
          questions[rule.name] = { type: "noul", instructions: rule.question };
        }
        const state = {
          role: "assistant",
          output_kind: output.kind,
          user_request: userRequest ?? "(the user's request is not available)",
          response: truncateMiddle(output.content, 8000),
        };
        const answers = await qevDecide(baseUrl, state, questions);
        const threshold = settings.judge.threshold;
        return candidates.filter((rule) => {
          const noul = answers[rule.name]?.noul;
          return typeof noul === "number" && noul >= threshold;
        });
      } catch (error) {
        warnOnce(ctx.logger ?? console, "qev", `qev judge failed (${error.message}); falling back to the chat judge`);
      }
    }
    return judgeWithChat(session, message, output, candidates, userRequest);
  }

  async function judgeWithChat(session, message, output, candidates, userRequest) {
    const llm = getLlm();
    if (llm === undefined) return [];
    const route =
      settings.generator ??
      (typeof message?.source?.provider === "string" && typeof message?.source?.model === "string"
        ? { provider: message.source.provider, model: message.source.model }
        : null);
    if (route === null) return [];
    const content = output.content.length > 12000 ? `${output.content.slice(0, 12000)}\n…[truncated]` : output.content;
    const prompt = [
      "Judge whether one assistant output violates any of the rules below. Each rule is a yes/no question about the output in the context of the user's request.",
      "",
      "User's request:",
      "<request>",
      userRequest ?? "(the user's request is not available)",
      "</request>",
      "",
      "Rules:",
      ...candidates.map((rule) => `- id: ${rule.name}\n  question: ${rule.question}`),
      "",
      `Output (${output.kind}${output.path != null ? `, file ${output.path}` : ""}):`,
      "<output>",
      content,
      "</output>",
      "",
      'Answer ONLY as JSON: {"answers":[{"id":"<rule id>","yes":true|false,"confidence":<0.0-1.0>}]} with exactly one entry per rule id.',
    ].join("\n");
    let text;
    try {
      text = await callGenerationModel(llm, route, JUDGE_SYSTEM, prompt, session.id, undefined);
    } catch (error) {
      warnOnce(ctx.logger ?? console, "judge", `judgment call failed: ${error.message}`);
      return [];
    }
    const answers = parseJudgeAnswers(text);
    return candidates.filter((rule) => {
      const answer = answers.get(rule.name);
      return answer !== undefined && answer.yes === true && answer.confidence >= 0.7;
    });
  }

  async function runJudgment(session, message) {
    const agent = (() => {
      try {
        return ctx.agents.get(session.id);
      } catch {
        return undefined;
      }
    })();
    if (agent === undefined) return;
    const state = stateOf(session.id);
    syncDisabled(state, session);
    const userRequest = lastUserRequest(agent);
    for (const output of messageOutputs(message)) {
      if (output.content.length < 40) continue;
      const candidates = questionRules
        .filter((rule) => {
          if (state.disabled.has(rule.name)) return false; // muted for this session
          if (output.kind === "text" && !rule.canText) return false;
          if (output.kind === "reasoning" && !rule.canReasoning) return false;
          if (output.kind === "tool") {
            if (!rule.canTool) return false;
            if (rule.tools.length > 0 && !rule.tools.includes(output.toolName)) return false;
            if (rule.globsRegexes.length > 0 && (output.path === null || !matchesGlobs(rule.globsRegexes, output.path))) return false;
          }
          if (!repeatAllows(state, session, rule)) return false;
          if (rule.regex !== null && !rule.regex.test(output.content)) return false;
          return true;
        })
        .slice(0, 5);
      if (candidates.length === 0) continue;
      const flagged = await judgeOutput(session, message, output, candidates, userRequest);
      if (flagged.length === 0) continue;
      const violations = [];
      for (const rule of flagged) {
        if (state.injected.has(rule.name)) continue;
        markInjected(state, rule.name);
        violations.push({ rule, excerpt: output.content.slice(0, 120) });
      }
      if (violations.length === 0) continue;
      const reminder = reminderMessage(violations, "observe");
      try {
        if (agent.status === "running") agent.inject(reminder);
        else agent.followup(reminder);
      } catch (error) {
        warnOnce(ctx.logger ?? console, "judge-deliver", `judged reminder delivery failed: ${error.message}`);
      }
    }
  }

  function queueJudgment(session, message) {
    const state = stateOf(session.id);
    if (state.judged.has(message.id)) return;
    state.judgmentQueue.push(message);
    if (state.judgmentBusy) return;
    state.judgmentBusy = true;
    (async () => {
      try {
        while (active && state.judgmentQueue.length > 0) {
          const next = state.judgmentQueue.shift();
          if (next === undefined) break;
          state.judged.add(next.id ?? String(next));
          try {
            await runJudgment(session, next);
          } catch (error) {
            warnOnce(ctx.logger ?? console, "judge", `judgment failed: ${error.message}`);
          }
        }
      } finally {
        state.judgmentBusy = false;
      }
    })();
  }


  // ---- passive tool reminders (observe-only rules, after the tool result) --
  ctx.on("tools/post-execute", async (exec, _result, next) => {
    const downstream = await next();
    try {
      if (exec.agent === undefined) return downstream;
      const key = `${exec.agent.id}:${exec.callId}`;
      const reminder = stateOf(exec.agent.id).passiveTools.get(key);
      if (reminder === undefined) return downstream;
      stateOf(exec.agent.id).passiveTools.delete(key);
      const contexts = [reminder, ...(downstream.additionalContexts ?? [])];
      return downstream.kind === "block"
        ? { kind: "block", feedback: downstream.feedback, additionalContexts: contexts }
        : { ...downstream, additionalContexts: contexts };
    } catch (error) {
      warnOnce(ctx.logger ?? console, "passive", `passive tool reminder failed: ${error.message}`);
      return downstream;
    }
  });

  // ---- recovery: inject the rule and retry the same step -------------------
  ctx.on("agent/request-error", async (payload, next) => {
    const { agent, turn, step, provider, failure, signal } = payload;
    if (failure?.code !== FAILURE_CODE) return next();
    const state = stateOf(agent.id);
    const pending = state.pending;
    state.pending = null;
    if (pending === null || !failure.message.includes(`[ttsr:${pending.nonce}]`)) return undefined;

    const stepKey = `${turn}:${step}`;
    state.currentStepKey = stepKey;
    if ((state.stepRetries.get(stepKey) ?? 0) >= settings.maxRetriesPerStep) return undefined;
    const attempt = (state.stepRetries.get(stepKey) ?? 0) + 1;
    state.stepRetries.set(stepKey, attempt);
    for (const violation of pending.violations) {
      markInjected(state, violation.rule.name, turn);
    }

    const retryId = randomUUID();
    const failureCopy = { message: failure.message, code: failure.code };
    try {
      agent.session.append("llm/retry", {
        retryId,
        turn,
        step,
        provider,
        mode: "normal",
        policyKey: "ttsr",
        retry: attempt,
        maxRetries: settings.maxRetriesPerStep,
        delayMs: settings.retryDelayMs,
        failure: failureCopy,
      });
    } catch (error) {
      warnOnce(ctx.logger ?? console, "retry-log", `llm/retry append failed: ${error.message}`);
    }
    if (settings.retryDelayMs > 0) {
      const proceeded = await new Promise((resolve) => {
        const timer = setTimeout(() => {
          signal?.removeEventListener("abort", onAbort);
          resolve(true);
        }, settings.retryDelayMs);
        function onAbort() {
          clearTimeout(timer);
          resolve(false);
        }
        if (signal?.aborted) return resolve(false);
        signal?.addEventListener("abort", onAbort, { once: true });
      });
      if (!proceeded) return undefined;
    }
    try {
      agent.session.append("llm/retry-started", { retryId, turn, step, retry: attempt });
    } catch {}
    try {
      agent.session.append("user/message", reminderMessage(pending.violations), { surfaceOp: "append" });
    } catch (error) {
      warnOnce(ctx.logger ?? console, "reminder", `reminder append failed: ${error.message}`);
      return undefined;
    }
    return { kind: "retry" };
  });

  // =========================================================================
  // Commands
  // =========================================================================

  ctx.commands.register({
    name: "omfg",
    description: "Generate a time-traveling stream rule from the conversation",
    input: { hint: "[description of the behavior to block]" },
    handler: (invocation) => runOmfg(ctx, settings, rules, invocation),
  });

  /** Toggle one rule for this session (used by /ttsr set, /ttsr on|off, and /ttsr-set). */
  function setSessionRule(invocation, name, mute) {
    const target = rules.find((rule) => rule.name === name) ?? rules.find((rule) => rule.name.startsWith(name));
    if (target === undefined) return { kind: "error", text: `TTSR: no rule named "${name}".` };
    const state = stateOf(invocation.agent.id);
    syncDisabled(state, sessionOf(invocation.agent));
    const next = new Set(state.disabled);
    if (mute) next.add(target.name);
    else next.delete(target.name);
    applyMutes(invocation.agent, next);
    return { kind: "success", text: `${SET_PREFIX}${JSON.stringify({ rules: ruleSnapshot(stateOf(invocation.agent.id)) })}` };
  }

  const sessionHelpers = { applyMutes, setSessionRule, syncDisabled, ruleSnapshot, sessionOf };

  ctx.commands.register({
    name: "ttsr",
    description: "Open the TTSR rule panel for this session (live toggle switches)",
    input: { hint: "[rules|list|set <name> on|off|mute|test <regex>|forget <name>|enable|disable]" },
    handler: (invocation) => runTtsr(ctx, settings, rules, sessionHelpers, invocation),
  });

  ctx.commands.register({
    name: "ttsr-set",
    description: "Toggle one TTSR rule for this session (used by the rule panel)",
    input: { hint: "<rule-name> on|off" },
    handler: (invocation) => {
      const parts = invocation.rawInput.trim().split(/\s+/);
      const name = parts[0] ?? "";
      const value = parts[1] ?? "";
      if (name.length === 0 || (value !== "on" && value !== "off")) {
        return { kind: "error", text: "Usage: /ttsr-set <rule-name> on|off" };
      }
      return setSessionRule(invocation, name, value === "off");
    },
  });
}

// ---------------------------------------------------------------------------
// /ttsr
// ---------------------------------------------------------------------------

async function runTtsr(ctx, settings, rules, helpers, invocation) {
  const input = invocation.rawInput.trim();
  const command = input.split(/\s+/, 1)[0]?.toLowerCase() ?? "";
  const rest = input.slice(command.length).trim();

  if (command === "" ) {
    if (rules.length === 0) return { kind: "success", text: "TTSR: no rules configured. Use /omfg <description> to generate one." };
    const state = stateOf(invocation.agent.id);
    helpers.syncDisabled(state, helpers.sessionOf(invocation.agent));
    return { kind: "success", text: `${PANEL_PREFIX}${JSON.stringify({ rules: helpers.ruleSnapshot(state) })}` };
  }

  if (command === "rules") {
    if (rules.length === 0) return { kind: "success", text: "TTSR: no rules configured. Use /omfg <description> to generate one." };
    const state = stateOf(invocation.agent.id);
    let selected;
    try {
      const answer = await ctx.userQuestions.ask({
        questions: [
          {
            id: "muted",
            header: "TTSR rules",
            question: "All rules are active by default. CHECK a rule to DISABLE it for this session only (the global config is not changed) — everything left unchecked stays active. Submitting with nothing checked re-enables everything.",
            options: rules.map((rule) => {
              const trigger =
                rule.regex !== null ? `/${rule.condition}/` : rule.astItems !== null ? `ast: ${rule.astCondition}` : `judge: ${rule.question.slice(0, 60)}`;
              return { label: rule.name, description: `${trigger.slice(0, 110)}` };
            }),
            multiSelect: true,
          },
        ],
        agent: invocation.agent,
        signal: invocation.signal,
      });
      selected = answer.answers.find((item) => item.id === "muted")?.selected ?? null;
    } catch (error) {
      const quiet = error?.code === "ASK_ABORTED" || /cancel|abort|dismiss/i.test(String(error?.message ?? ""));
      if (quiet) return { kind: "success", text: "TTSR: rule panel closed without changes." };
      return { kind: "error", text: `TTSR: could not open the rule panel (${error.message}). Use /ttsr off <name> instead.` };
    }
    if (selected === null) return { kind: "success", text: "TTSR: rule panel closed without changes." };
    const next = new Set(selected.filter((label) => rules.some((rule) => rule.name === label)));
    helpers.applyMutes(invocation.agent, next);
    return {
      kind: "success",
      text: `${SET_PREFIX}${JSON.stringify({ rules: helpers.ruleSnapshot(stateOf(invocation.agent.id)) })}`,
    };
  }

  if (command === "set") {
    const parts = rest.split(/\s+/);
    const name = parts[0] ?? "";
    const value = parts[1] ?? "";
    if (name.length === 0 || (value !== "on" && value !== "off")) {
      return { kind: "error", text: "Usage: /ttsr set <rule-name> on|off" };
    }
    return helpers.setSessionRule(invocation, name, value === "off");
  }

  if (command === "off" || command === "on") {
    if (rest.length === 0) {
      if (command === "off") return { kind: "success", text: "TTSR: /ttsr off needs a rule name, or use /ttsr mute to silence everything." };
      helpers.applyMutes(invocation.agent, new Set());
      return {
        kind: "success",
        text: `${SET_PREFIX}${JSON.stringify({ rules: helpers.ruleSnapshot(stateOf(invocation.agent.id)) })}`,
      };
    }
    return helpers.setSessionRule(invocation, rest, command === "off");
  }

  if (command === "mute") {
    helpers.applyMutes(invocation.agent, new Set(rules.map((rule) => rule.name)));
    return {
      kind: "success",
      text: `${SET_PREFIX}${JSON.stringify({ rules: helpers.ruleSnapshot(stateOf(invocation.agent.id)) })}`,
    };
  }

  if (command === "enable" || command === "disable") {
    const saved = await writeConfig(ctx, (current) => ({ ...(current ?? {}), enabled: command === "enable" }));
    return saved
      ? { kind: "success", text: `TTSR ${command === "enable" ? "enabled" : "disabled"} globally.` }
      : { kind: "error", text: "TTSR: could not persist the setting (configEditor unavailable)." };
  }

  if (command === "forget") {
    if (rest.length === 0) return { kind: "error", text: "Usage: /ttsr forget <rule-name>" };
    const existing = rules.find((rule) => rule.name === rest);
    if (existing === undefined) {
      return { kind: "error", text: `TTSR: no rule named "${rest}". Run /ttsr to list rules.` };
    }
    const outcome = await writeConfig(ctx, (current) => ({
      ...(current ?? {}),
      rules: (Array.isArray(current?.rules) ? current.rules : []).filter((entry) => entry?.name !== rest),
    }));
    return outcome === true
      ? { kind: "success", text: `TTSR: removed rule "${rest}".` }
      : { kind: "error", text: `TTSR: could not remove rule "${rest}" (${typeof outcome === "object" && outcome !== null ? outcome.error : "configEditor unavailable"}).` };
  }

  if (command === "test") {
    if (rest.length === 0) return { kind: "error", text: "Usage: /ttsr test <regex source>" };
    let regex;
    try {
      regex = new RegExp(rest, "gm");
    } catch (error) {
      return { kind: "error", text: `TTSR: invalid regex: ${error.message}` };
    }
    const messages = safeDerivedMessages(invocation.agent);
    let hits = 0;
    let scanned = 0;
    for (const message of messages) {
      if (message.role !== "assistant") continue;
      for (const block of message.content ?? []) {
        if (block.type === "text" || (block.type === "tool-call" && typeof block.arguments === "string")) {
          const text = block.type === "text" ? block.text : block.arguments;
          scanned += 1;
          regex.lastIndex = 0;
          let match;
          while ((match = regex.exec(text)) !== null) {
            hits += 1;
            if (match[0].length === 0) regex.lastIndex += 1;
            if (hits >= 999) break;
          }
        }
      }
    }
    return {
      kind: "success",
      text: `TTSR test /${rest}/gm: ${hits} match(es) across ${scanned} assistant block(s) in this session.`,
    };
  }

  if (command !== "list") {
    return { kind: "error", text: "Usage: /ttsr [rules|list|on|off <name>|mute|test <regex>|forget <name>]" };
  }

  if (rules.length === 0) {
    return { kind: "success", text: "TTSR: no rules configured. Use /omfg <description> to generate one." };
  }
  const sessionState = stateOf(invocation.agent.id);
  const lines = rules.map((rule) => {
    const triggers = [
      rule.regex !== null ? `/${rule.condition}/` : null,
      rule.astItems !== null ? `ast:${rule.astCondition}` : null,
      rule.question !== undefined ? `question:"${rule.question}"` : null,
    ]
      .filter(Boolean)
      .join(" + ");
    const scope = rule.scope.join("+");
    const tools = rule.tools.length > 0 ? ` tools:${rule.tools.join(",")}` : "";
    const globs = rule.globs.length > 0 ? ` globs:${rule.globs.join(",")}` : "";
    const muted = sessionState.disabled.has(rule.name) ? " [MUTED this session]" : "";
    return `- ${rule.name} [${triggers}] scope=${scope}${tools}${globs} interrupt=${rule.interruptMode} repeat=${rule.repeatMode}${muted}`;
  });
  return {
    kind: "success",
    text: `TTSR ${settings.enabled ? "enabled" : "DISABLED"}, ${rules.length} rule(s):\n${lines.join("\n")}\nFired rules are suppressed per their repeat policy; state survives reload.`,
  };
}

// ---------------------------------------------------------------------------
// /omfg
// ---------------------------------------------------------------------------

const OMFG_SYSTEM = [
  "You generate TTSR (time-traveling stream rule) definitions for an agent harness.",
  "A TTSR rule is a dormant regex guard: it watches the assistant's output stream",
  "(prose, reasoning, and tool-call arguments) and, when the pattern matches, aborts",
  "the response mid-stream, injects the rule text as a reminder, and retries the same step.",
].join(" ");

function omfgUserPrompt(description, transcript, existing) {
  return [
    "You write TTSR enforcement rules for an agent harness. A rule watches the assistant's live output and fires when the assistant misbehaves.",
    "",
    "The user's complaint, verbatim:",
    "<complaint>",
    description,
    "</complaint>",
    "",
    existing.length > 0 ? `Existing rules (do not duplicate them; make the new rules MORE specific than these): ${existing.join(", ")}` : "No rules exist yet.",
    "",
    "The conversation follows. Work in two steps. STEP 1: read the conversation and find the EXACT places where the assistant did what the user is complaining about — quote them verbatim. STEP 2: write rules that would have fired on exactly those quotes and would NOT have fired on the assistant's diligent work in the same conversation.",
    "",
    "<conversation>",
    transcript,
    "</conversation>",
    "",
    "Write 1-3 rules as a JSON object of this exact shape:",
    '{"rules":[{"name":"kebab-case-id","condition":"javascript regex","astCondition":"code pattern","question":"yes/no question","message":"imperative instruction","evidence":["verbatim quote from the conversation that this rule must catch"],"scope":["text","tool"],"globs":["*.ts"],"interruptMode":"always","repeatMode":"once"}]}',
    "Requirements:",
    "- evidence (required): at least one verbatim quote, 10-200 characters, copied character-for-character from the conversation above, showing the exact offending behavior. A rule whose evidence cannot be found in the conversation is rejected.",
    "- condition: a JavaScript regex that MUST match your own evidence quotes, and must not match the diligent parts of the conversation. Be specific: use the phrases the assistant actually used, not abstract categories. Escape regex metacharacters. It must not match the empty string.",
    '- astCondition: a structural code pattern with metavariables ($VAR one token, $$$ARGS any span), matched against code that edit/write tools produce. Only with scope ["tool"], ideally with globs. Example: "console.log($$$ARGS)".',
    "- question: a precise yes/no question for a judgment model that reads the user's request and the response together. Use it when the wording varies too much for a regex; name the specific behavior from the complaint and evidence.",
    "- message: one imperative sentence the assistant must follow when the rule fires, written for THIS complaint — not a generic anti-laziness slogan.",
    "- Do not write rules for behaviors that do not appear in your evidence. Do not write generic rules.",
    "Return ONLY the JSON object. No prose, no code fences.",
  ]
    .filter(Boolean)
    .join("\n");
}

function safeDerivedMessages(agent) {
  try {
    const messages = agent.session.deriveMessages();
    return Array.isArray(messages) ? messages : [];
  } catch {
    return [];
  }
}

function sessionOf(agent) {
  try {
    return agent.session;
  } catch {
    return undefined;
  }
}

function lastAssistantRoute(messages) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === "assistant" && typeof message?.source?.provider === "string" && typeof message?.source?.model === "string") {
      return { provider: message.source.provider, model: message.source.model };
    }
  }
  return null;
}

function renderTranscript(messages, budget = 120000) {
  const lines = [];
  let total = 0;
  const assistantTotal = messages.filter((message) => message?.role === "assistant").length;
  let assistantSeen = 0;
  for (const message of messages) {
    const parts = [];
    if (message?.role === "user" && message?.source?.kind === "user") {
      for (const block of message.content ?? []) {
        if (block?.type === "text") parts.push(block.text.slice(0, 3000));
      }
    } else if (message?.role === "user") {
      for (const block of message.content ?? []) {
        if (block?.type === "text") parts.push(`(injected context) ${block.text.slice(0, 400)}`);
      }
    } else if (message?.role === "assistant") {
      assistantSeen += 1;
      const remaining = assistantTotal - assistantSeen;
      const cap = remaining < 12 ? 2500 : remaining < 40 ? 700 : 250;
      for (const block of message.content ?? []) {
        if (block?.type === "text") parts.push(block.text.slice(0, cap));
        else if (block?.type === "reasoning") parts.push(`(reasoning) ${block.text.slice(0, 200)}`);
        else if (block?.type === "tool-call") parts.push(`tool ${block.name}(${String(block.arguments).slice(0, 300)})`);
      }
    } else if (message?.role === "tool") {
      for (const block of message.content ?? []) {
        if (block?.type === "text") parts.push(`(tool result) ${block.text.slice(0, 200)}`);
      }
    }
    if (parts.length > 0) {
      const line = `${message.role}: ${parts.join(" ")}`;
      lines.push(line);
      total += line.length;
      if (total > budget) break;
    }
  }
  return lines.join("\n");
}

function normalizeForGrounding(text) {
  return String(text ?? "").replace(/\s+/g, " ").trim();
}

function evidenceIsGrounded(quote, groundingText) {
  const normalized = normalizeForGrounding(quote);
  if (normalized.length < 12) return false;
  if (groundingText.includes(normalized)) return true;
  const prefix = normalized.slice(0, 60);
  return prefix.length >= 12 && groundingText.includes(prefix);
}

function assistantCorpus(messages) {
  const corpus = [];
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    for (const block of message.content ?? []) {
      if (block.type === "text" && typeof block.text === "string") corpus.push(block.text);
      else if (block.type === "tool-call" && typeof block.arguments === "string") corpus.push(block.arguments);
    }
  }
  return corpus;
}

function parseCandidates(text) {
  const stripped = String(text ?? "").replace(/^```(?:json)?\s*/m, "").replace(/```\s*$/m, "").trim();
  const start = stripped.indexOf("{");
  const end = stripped.lastIndexOf("}");
  if (start < 0 || end <= start) return [];
  const slice = stripped.slice(start, end + 1);
  let parsed;
  try {
    parsed = JSON.parse(slice);
  } catch {
    try {
      parsed = JSON.parse(slice.replace(/,\s*([}\]])/g, "$1"));
    } catch {
      return [];
    }
  }
  const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.rules) ? parsed.rules : [];
  return list.filter((entry) => entry !== null && typeof entry === "object");
}

function slugify(value) {
  const slug = String(value)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return slug.length > 0 ? slug : `rule-${randomUUID().slice(0, 6)}`;
}

function validateCandidates(candidates, corpus, existingNames, groundingText, logger) {
  const validated = [];
  const rejected = [];
  const names = new Set(existingNames);
  const grounding = normalizeForGrounding(groundingText);
  for (const raw of candidates.slice(0, 5)) {
    const condition = typeof raw.condition === "string" ? raw.condition : "";
    const astCondition = typeof raw.astCondition === "string" ? raw.astCondition.trim() : "";
    const question = typeof raw.question === "string" ? raw.question.trim() : "";
    const evidence = (Array.isArray(raw.evidence) ? raw.evidence : typeof raw.evidence === "string" ? [raw.evidence] : [])
      .filter((entry) => typeof entry === "string" && entry.trim().length >= 10)
      .map((entry) => entry.trim().slice(0, 300));
    const reject = (reason) => {
      rejected.push(reason);
      warnOnce(logger, "omfg", reason);
    };
    if (evidence.length === 0) {
      reject(`candidate "${String(raw.name ?? "?")}" rejected: no evidence quote`);
      continue;
    }
    const grounded = evidence.filter((quote) => evidenceIsGrounded(quote, grounding));
    if (grounded.length === 0) {
      reject(`candidate "${String(raw.name ?? "?")}" rejected: evidence quote not found in the conversation`);
      continue;
    }
    const rule = compileRule(
      {
        name: typeof raw.name === "string" && raw.name.length > 0 ? raw.name : slugify(raw.name ?? raw.condition ?? "rule"),
        condition,
        astCondition,
        question,
        message: typeof raw.message === "string" ? raw.message : "",
        scope: Array.isArray(raw.scope) ? raw.scope : undefined,
        tools: Array.isArray(raw.tools) ? raw.tools : [],
        globs: Array.isArray(raw.globs) ? raw.globs : [],
        interruptMode: typeof raw.interruptMode === "string" ? raw.interruptMode : "always",
        repeatMode: typeof raw.repeatMode === "string" ? raw.repeatMode : "once",
        repeatGap: Number.isInteger(raw.repeatGap) ? raw.repeatGap : 10,
      },
      logger,
    );
    if (rule === null) continue;
    if (names.has(rule.name)) continue;
    if (condition.length > 0 && new RegExp(`^(?:${condition})$`, "m").test("")) {
      reject(`candidate "${rule.name}" rejected: condition matches the empty string`);
      continue;
    }
    if (condition.length > 0) {
      let matchesEvidence = false;
      for (const quote of grounded) {
        if (new RegExp(condition, "m").test(quote)) {
          matchesEvidence = true;
          break;
        }
      }
      if (!matchesEvidence) {
        reject(`candidate "${rule.name}" rejected: the regex does not match its own evidence quote`);
        continue;
      }
    }
    names.add(rule.name);
    let hits = 0;
    try {
      if (condition.length > 0) {
        const regex = new RegExp(condition, "gm");
        for (const text of corpus) {
          regex.lastIndex = 0;
          let match;
          while ((match = regex.exec(text)) !== null) {
            hits += 1;
            if (match[0].length === 0) regex.lastIndex += 1;
            if (hits >= 999) break;
          }
          if (hits >= 999) break;
        }
      }
    } catch {}
    validated.push({ ...rule, hits, evidence: grounded });
  }
  return { validated, rejected };
}

async function callGenerationModel(llm, route, system, prompt, sessionId, signal, options = {}) {
  // Auxiliary calls (rule generation, judging) do not need deep reasoning by default;
  // pick a low effort when the route exposes one so reasoning cannot consume the budget.
  const effortPreference = Array.isArray(options.effortPreference) && options.effortPreference.length > 0
    ? options.effortPreference
    : ["low", "medium", "high", "min"];
  const maxTokens = Number.isInteger(options.maxTokens) && options.maxTokens > 0 ? options.maxTokens : 4096;
  const call = await llm.prepareCall({ provider: route.provider, model: route.model, maxTokens }, signal, (controls, model) => {
    const efforts = model?.reasoning?.efforts;
    if (Array.isArray(efforts)) {
      const preferred = effortPreference.find((id) => efforts.some((effort) => effort?.id === id));
      if (preferred !== undefined) return { ...controls, reasoningEffort: preferred };
    }
    return controls;
  });
  const request = Object.freeze({
    ...call.config,
    system,
    sessionId,
    signal,
    messages: [
      {
        id: randomUUID(),
        role: "user",
        content: [{ type: "text", text: prompt }],
        source: { kind: "dsh-ttsr:generator" },
      },
    ],
  });
  INTERNAL_REQUESTS.add(request);
  let text = "";
  for await (const chunk of call.stream(request)) {
    if (chunk.type === "text-delta") text += chunk.text;
    else if (chunk.type === "finish") {
      if (chunk.reason.kind === "error" || chunk.reason.kind === "aborted") {
        throw new Error(chunk.reason.failure.message);
      }
    }
  }
  return text;
}

async function writeConfig(ctx, mutate) {
  const editor = (() => {
    try {
      return ctx.get("configEditor");
    } catch {
      return undefined;
    }
  })();
  if (editor === undefined || typeof editor.entries !== "function" || typeof editor.edit !== "function") return null;
  try {
    const entries = editor.entries();
    const entry = entries.find((candidate) => {
      if (candidate === null || typeof candidate !== "object") return false;
      for (const key of ["id", "patchId", "name", "plugin", "package"]) {
        const value = candidate[key];
        if (typeof value === "string" && value.includes("dsh-ttsr")) return true;
      }
      return false;
    });
    if (entry === undefined) return null;
    await editor.edit(entry, (current, inherited) => mutate(current ?? {}, inherited));
    return true;
  } catch (error) {
    return { error: error.message };
  }
}

async function runOmfg(ctx, settings, rules, invocation) {
  const { agent, signal } = invocation;
  const description = invocation.rawInput.trim();
  if (description.length === 0) {
    return { kind: "error", text: "TTSR: describe the behavior to block, e.g. /omfg never use Box::leak in Rust code" };
  }
  const llm = (() => {
    try {
      return ctx.get("llm");
    } catch {
      return undefined;
    }
  })();
  if (llm === undefined) return { kind: "error", text: "TTSR: the llm service is unavailable in this profile." };

  const messages = safeDerivedMessages(agent);
  const transcript = renderTranscript(messages);
  if (transcript.length === 0) {
    return { kind: "error", text: "TTSR: no conversation to analyze yet — send a message first." };
  }
  const route = settings.generator ?? lastAssistantRoute(messages);
  if (route === null) {
    return {
      kind: "error",
      text: "TTSR: no model route available. Send a message first, or set ttsr generator.provider/model.",
    };
  }

  const prompt = omfgUserPrompt(description, transcript, rules.map((rule) => rule.name));
  let generated;
  try {
    // Rule generation must genuinely understand the complaint: read the full
    // context with real reasoning effort and room for quoted evidence.
    generated = await callGenerationModel(llm, route, OMFG_SYSTEM, prompt, agent.id, signal, {
      effortPreference: ["medium", "high", "low"],
      maxTokens: 8192,
    });
  } catch (error) {
    return { kind: "error", text: `TTSR: rule generation failed: ${error.message}` };
  }

  const { validated: candidates, rejected } = validateCandidates(
    parseCandidates(generated),
    assistantCorpus(messages),
    rules.map((rule) => rule.name),
    `${transcript}\n${description}`,
    ctx.logger ?? console,
  );
  if (candidates.length === 0) {
    const rejectionNotes = rejected.length > 0 ? `\nRejected candidates:\n- ${rejected.join("\n- ")}` : "";
    return {
      kind: "error",
      text: `TTSR: the model produced no usable rules. Raw generation (first 500 characters):\n${generated.slice(0, 500)}${rejectionNotes}`,
    };
  }

  let selectedLabels;
  try {
    const answer = await ctx.userQuestions.ask({
      questions: [
        {
          id: "save",
          header: "TTSR",
          question: `Save which stream rule${candidates.length > 1 ? "s" : ""}? Match counts are against this session's recent output.`,
          options: candidates.map((candidate) => {
            const trigger =
              candidate.condition !== undefined
                ? `/${candidate.condition}/`
                : candidate.astCondition !== undefined
                  ? `ast: ${candidate.astCondition}`
                  : `judge: ${candidate.question}`;
            const hits = candidate.condition !== undefined ? `${candidate.hits} recent match(es)` : "fires on future output";
            const evidence = candidate.evidence !== undefined && candidate.evidence.length > 0 ? ` catches: "${candidate.evidence[0].slice(0, 90)}"` : "";
            return { label: candidate.name, description: `${trigger} —${evidence}; ${hits}; ${candidate.message}` };
          }),
          multiSelect: true,
        },
      ],
      agent,
      signal,
    });
    selectedLabels = answer.answers.find((item) => item.id === "save")?.selected ?? [];
  } catch (error) {
    const yamlRules = candidates
      .map(
        (candidate) =>
          `  - name: ${candidate.name}\n    condition: ${JSON.stringify(candidate.condition)}\n    message: ${JSON.stringify(candidate.message)}`,
      )
      .join("\n");
    return {
      kind: "error",
      text: `TTSR: interactive confirmation unavailable (${error.message}). Candidates:\n${yamlRules}\nAdd them under ttsr.rules in cordis.patch.yml to install.`,
    };
  }

  const chosen = candidates.filter((candidate) => selectedLabels.includes(candidate.name));
  if (chosen.length === 0) return { kind: "success", text: "TTSR: nothing saved." };

  const outcome = await writeConfig(ctx, (current) => {
    const existingRules = Array.isArray(current.rules) ? [...current.rules] : [];
    for (const candidate of chosen) {
      const ruleConfig = {
        name: candidate.name,
        message: candidate.message,
        scope: candidate.scope,
        ...(candidate.condition !== undefined ? { condition: candidate.condition } : {}),
        ...(candidate.astCondition !== undefined ? { astCondition: candidate.astCondition } : {}),
        ...(candidate.question !== undefined ? { question: candidate.question } : {}),
        ...(candidate.tools.length > 0 ? { tools: candidate.tools } : {}),
        ...(candidate.globs.length > 0 ? { globs: candidate.globs } : {}),
        interruptMode: candidate.interruptMode,
        repeatMode: candidate.repeatMode,
        ...(candidate.repeatMode === "after-gap" ? { repeatGap: candidate.repeatGap } : {}),
      };
      const index = existingRules.findIndex((entry) => entry?.name === candidate.name);
      if (index >= 0) existingRules[index] = ruleConfig;
      else existingRules.push(ruleConfig);
    }
    return { ...current, rules: existingRules };
  });

  if (outcome === null) {
    const yamlRules = chosen
      .map(
        (candidate) =>
          `  - name: ${candidate.name}\n    condition: ${JSON.stringify(candidate.condition)}\n    message: ${JSON.stringify(candidate.message)}`,
      )
      .join("\n");
    return {
      kind: "error",
      text: `TTSR: configEditor unavailable; add these under ttsr.rules in cordis.patch.yml:\n${yamlRules}`,
    };
  }
  if (typeof outcome === "object" && outcome !== null) {
    return { kind: "error", text: `TTSR: saving failed: ${outcome.error}` };
  }
  return {
    kind: "success",
    text: `TTSR: saved ${chosen.map((candidate) => candidate.name).join(", ")}. The rulebook reloads automatically.`,
  };
}

export { Config, apply, inject, name };
