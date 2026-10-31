// @local/dsh-ttsr — Client half: renders the "stream rule injected" chat card.
//
// The Host appends `user/message` events whose source.kind is "dsh-ttsr:reminder".
// A conversation event definition claims those events and builds a custom chat
// node (kind "dsh-ttsr-reminder"); the slot registration below renders it as an
// amber rule card instead of a synthetic user row.

window.__ModuleLoader__.load({
  id: "@local/dsh-ttsr",
  factory: (require) => {
    const React = require("react");
    const h = React.createElement;

    const NS = "dsh-ttsr";
    const REMINDER_SOURCE = "dsh-ttsr:reminder";
    const NODE_KIND = "dsh-ttsr-reminder";
    const PANEL_KIND = "dsh-ttsr-panel";
    const HIDDEN_KIND = "dsh-ttsr-panel-hidden";
    const PANEL_PREFIX = "TTSR-PANEL ";
    const SET_PREFIX = "TTSR-SET ";
    const CONFIG_PREFIX = "TTSR-CFG ";
    const PANEL_SUBCOMMANDS = /^\s*(rules|list|set|on|off|mute|test|forget|enable|disable)\b/;

    const dictionaries = {
      en: {
        cardTitle: "Stream rule injected",
        observeTitle: "Stream rule matched",
        softTitle: "Stream rule noted — keep both tracks",
        continueTitle: "Turn ended early — work restarted",
        retryNote: "The violating attempt was discarded and the step was retried with this rule applied.",
        observeNote: "The output was not interrupted; this reminder was injected for the next step.",
        softNote: "Allowed through with a note: pragmatic work is fine, but it must not be the only focus — keep the full engineering going.",
        continueNote: "The previous turn ended with the requested work unfinished; this reminder restarted the work.",
        matched: "matched",
        ruleLabel: "rule",
        panelTitle: "TTSR rules",
        panelNote: "Toggles apply to THIS session only and persist with it; other sessions are unaffected.",
        dockButton: "TTSR rules",
        noRules: "No rules configured — use /omfg <description>.",
        on: "ON",
        off: "OFF",
        toggleAll: "All rules",
        disabledSuffix: "disabled",
        settingsTitle: "TTSR settings",
        settingsHint: "qev is LabQoat's local open-weights decision model speaking the System One protocol that TypeSafe's jev uses; the thresholds below drive the detection → decision → execution gate.",
        fieldModel: "Decision model",
        fieldModelExternal: "external server",
        fieldGenerator: "Rule generation model",
        generatorSession: "Follow session model",
        generatorHint: "Model /omfg uses to generate rules. \"Follow session model\" uses whatever produced the last reply.",
        fieldKind: "Judge",
        fieldBaseUrl: "Server URL",
        fieldThreshold: "Threshold (soft)",
        fieldHardThreshold: "Threshold (hard)",
        fieldMaxRetries: "Max retries / step",
        fieldRetryDelay: "Retry delay (ms)",
        fieldMonitorSubagents: "Monitor subagents",
        fieldEnabled: "TTSR enabled",
        save: "Save",
        testQev: "Test qev",
        reachable: "qev reachable",
        unreachable: "qev unreachable",
        saved: "Saved",
      },
      zh: {
        cardTitle: "已注入流规则",
        observeTitle: "命中流规则",
        softTitle: "已记录流规则 — 双线并行",
        continueTitle: "回合提前结束 — 已重启工作",
        retryNote: "违规输出已被丢弃，并在应用该规则后重试了本步骤。",
        observeNote: "输出未被中断；该提醒已注入供下一步使用。",
        softNote: "已放行并附注：务实工作没问题，但不能只做它 — 全面的工程工作要继续。",
        continueNote: "上一回合在请求的工作未完成时结束；此提醒已重启工作。",
        matched: "命中",
        ruleLabel: "规则",
        panelTitle: "TTSR 规则",
        panelNote: "开关仅对本会话生效并随会话持久保存；其他会话不受影响。",
        dockButton: "TTSR 规则",
        noRules: "暂无规则 — 使用 /omfg <描述> 生成。",
        on: "开",
        off: "关",
        toggleAll: "全部规则",
        disabledSuffix: "已禁用",
        settingsTitle: "TTSR 设置",
        settingsHint: "qev 是 LabQoat 的本地开源决策模型，遵循 TypeSafe jev 使用的 System One 协议；下方阈值驱动 检测 → 决策 → 执行 门控。",
        fieldModel: "决策模型",
        fieldModelExternal: "外部服务",
        fieldGenerator: "规则生成模型",
        generatorSession: "跟随会话模型",
        generatorHint: "/omfg 生成规则时使用的模型。“跟随会话模型”即使用最近一次回复的模型。",
        fieldKind: "判定器",
        fieldBaseUrl: "服务地址",
        fieldThreshold: "阈值（软）",
        fieldHardThreshold: "阈值（硬）",
        fieldMaxRetries: "每步最大重试",
        fieldRetryDelay: "重试延迟（毫秒）",
        fieldMonitorSubagents: "监控子代理",
        fieldEnabled: "启用 TTSR",
        save: "保存",
        testQev: "测试 qev",
        reachable: "qev 可达",
        unreachable: "qev 不可达",
        saved: "已保存",
      },
    };

    const CARD_CSS = [
      `.${NS}-card {`,
      `  border: 1px solid var(--dsw-alias-state-warn-primary);`,
      `  border-left: 3px solid var(--dsw-alias-state-warn-primary);`,
      `  background: var(--dsw-alias-bg-layer-1);`,
      `  border-radius: var(--dsw-radius-xl, 12px);`,
      `  box-shadow: var(--dsw-shadow-lv2, none);`,
      `  padding: 10px 14px 12px 14px;`,
      `  margin: 6px 0;`,
      `  display: flex;`,
      `  flex-direction: column;`,
      `  gap: 6px;`,
      `  max-width: var(--dsh-chat-content-width, 100%);`,
      `}`,
      `.${NS}-head { display: flex; align-items: center; gap: 8px; }`,
      `.${NS}-title { color: var(--dsw-alias-state-warn-primary); font-weight: 600; font-size: 13px; }`,
      `.${NS}-icon { flex: 0 0 auto; display: inline-flex; }`,
      `.${NS}-rule { display: flex; flex-direction: column; gap: 2px; padding-left: 26px; }`,
      `.${NS}-rulename { color: var(--dsw-alias-label-primary); font-size: 12px; font-weight: 600; }`,
      `.${NS}-excerpt {`,
      `  color: var(--dsw-alias-label-secondary);`,
      `  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;`,
      `  font-size: 11px;`,
      `  white-space: pre-wrap;`,
      `  word-break: break-word;`,
      `  border-left: 2px solid var(--dsw-alias-border-l1);`,
      `  padding-left: 8px;`,
      `}`,
      `.${NS}-message { color: var(--dsw-alias-label-primary); font-size: 12.5px; padding-left: 26px; }`,
      `.${NS}-note { color: var(--dsw-alias-label-secondary); font-size: 11.5px; padding-left: 26px; }`,
      `.${NS}-panel {`,
      `  border: 1px solid var(--dsw-alias-border-l2);`,
      `  background: var(--dsw-alias-bg-layer-1);`,
      `  border-radius: var(--dsw-radius-xl, 12px);`,
      `  box-shadow: var(--dsw-shadow-lv2, none);`,
      `  padding: 10px 14px 12px 14px;`,
      `  margin: 6px 0;`,
      `  display: flex;`,
      `  flex-direction: column;`,
      `  gap: 4px;`,
      `  max-width: var(--dsh-chat-content-width, 100%);`,
      `}`,
      `.${NS}-panel-head { display: flex; flex-direction: column; gap: 2px; padding-bottom: 4px; border-bottom: 1px solid var(--dsw-alias-border-l1); }`,
      `.${NS}-panel-title { color: var(--dsw-alias-label-primary); font-weight: 600; font-size: 13px; }`,
      `.${NS}-panel-sub { color: var(--dsw-alias-label-secondary); font-size: 11px; }`,
      `.${NS}-panel-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 3px 0; }`,
      `.${NS}-panel-name { color: var(--dsw-alias-label-primary); font-size: 12.5px; font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }`,
      `.${NS}-panel-trigger { color: var(--dsw-alias-label-secondary); font-size: 10.5px; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 420px; }`,
      `.${NS}-panel-master { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 6px 0 8px; border-bottom: 0.5px solid var(--dsw-alias-border-l2); margin-bottom: 6px; }`,
      `.${NS}-panel-master-label { color: var(--dsw-alias-label-primary); font-size: 12px; font-weight: 600; }`,
      `.${NS}-panel-count { color: var(--dsw-alias-label-tertiary); font-size: 10.5px; }`,
      `.${NS}-gear { display: inline-flex; align-items: center; justify-content: center; width: 22px; height: 22px; border: none; background: transparent; color: var(--dsw-alias-label-tertiary); border-radius: var(--dsw-radius-sm); cursor: pointer; padding: 0; flex: 0 0 auto; }`,
      `.${NS}-gear:hover, .${NS}-gear[aria-pressed="true"] { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }`,
      `.${NS}-field { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 4px 0; }`,
      `.${NS}-generator { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }`,
      `.${NS}-field-label { color: var(--dsw-alias-label-secondary); font-size: 11.5px; }`,
      `.${NS}-input, .${NS}-select { box-sizing: border-box; font: inherit; font-size: 11.5px; color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-layer-2); border: 0.5px solid var(--dsw-alias-border-l2); border-radius: var(--dsw-radius-sm); padding: 3px 6px; width: 180px; }`,
      `.${NS}-input:focus-visible, .${NS}-select:focus-visible { outline: 1px solid var(--dsw-alias-state-business-primary); outline-offset: 1px; }`,
      `.${NS}-input:disabled { opacity: 0.6; }`,
      `.${NS}-actions { display: flex; gap: 8px; align-items: center; padding-top: 8px; }`,
      `.${NS}-btn { font: inherit; font-size: 11.5px; padding: 3px 10px; border-radius: var(--dsw-radius-sm); border: 0.5px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); cursor: pointer; }`,
      `.${NS}-btn:hover { background: var(--dsw-alias-interactive-bg-hover); }`,
      `.${NS}-btn[disabled] { opacity: 0.5; cursor: wait; }`,
      `.${NS}-status { font-size: 10.5px; color: var(--dsw-alias-label-tertiary); }`,
      `.${NS}-status[data-ok="true"] { color: var(--dsw-alias-state-success-primary); }`,
      `.${NS}-hint { font-size: 10px; color: var(--dsw-alias-label-tertiary); padding: 2px 0 6px; }`,
      `.${NS}-switch {`,
      `  flex: 0 0 auto;`,
      `  width: 40px;`,
      `  height: 22px;`,
      `  border-radius: 11px;`,
      `  border: 1px solid var(--dsw-alias-border-l2);`,
      `  background: var(--dsw-alias-bg-layer-2);`,
      `  position: relative;`,
      `  cursor: pointer;`,
      `  padding: 0;`,
      `  transition: background 120ms ease;`,
      `}`,
      `.${NS}-switch[data-on="true"] { background: var(--dsw-alias-state-success-primary); border-color: var(--dsw-alias-state-success-primary); }`,
      `.${NS}-switch-knob {`,
      `  position: absolute;`,
      `  top: 2px;`,
      `  left: 2px;`,
      `  width: 16px;`,
      `  height: 16px;`,
      `  border-radius: 50%;`,
      `  background: var(--dsw-alias-label-primary);`,
      `  transition: left 120ms ease;`,
      `}`,
      `.${NS}-switch[data-on="true"] .${NS}-switch-knob { left: 20px; }`,
      `.${NS}-switch[disabled] { opacity: 0.5; cursor: wait; }`,
      // Dock entry: exact live StatsPills design language (from the shipped sheet).
      `.${NS}-dock {`,
      `  min-width: 0;`,
      `  font-size: calc(var(--dsh-content-font-size-secondary, 13px) - 1px);`,
      `  line-height: calc(20px + var(--dsh-content-font-delta-secondary, 0px));`,
      `  display: inline-flex;`,
      `}`,
      `.${NS}-dock-btn {`,
      `  box-sizing: border-box;`,
      `  border-radius: var(--dsw-radius-sm);`,
      `  max-width: 100%;`,
      `  color: var(--dsw-alias-label-tertiary);`,
      `  font: inherit;`,
      `  font-variant-numeric: tabular-nums;`,
      `  line-height: inherit;`,
      `  white-space: nowrap;`,
      `  background: 0 0;`,
      `  border: none;`,
      `  align-items: center;`,
      `  gap: 6px;`,
      `  padding: 1px 8px;`,
      `  display: inline-flex;`,
      `  cursor: pointer;`,
      `}`,
      `.${NS}-dock-btn:hover, .${NS}-dock-btn[aria-expanded="true"] {`,
      `  background: var(--dsw-alias-interactive-bg-hover);`,
      `  color: var(--dsw-alias-label-secondary);`,
      `}`,
      `.${NS}-dock-btn svg { flex: none; width: 14px; height: 14px; }`,
      `.${NS}-dock-label { text-overflow: ellipsis; min-width: 0; overflow: hidden; }`,
      // Panel: the shipped stat-dialog design language.
      `.${NS}-dock .${NS}-panel {`,
      `  position: absolute;`,
      `  bottom: calc(100% + 6px);`,
      `  right: 0;`,
      `  z-index: 1100;`,
      `  box-sizing: border-box;`,
      `  border-radius: var(--dsw-radius-lg);`,
      `  background: var(--dsw-specific-menu);`,
      `  width: max-content;`,
      `  min-width: min(320px, 100vw - 24px);`,
      `  max-width: min(480px, 100vw - 24px);`,
      `  backdrop-filter: var(--dsw-menu-backdrop-filter);`,
      `  box-shadow: var(--dsw-elevation-prominent);`,
      `  color: var(--dsw-alias-label-secondary);`,
      `  border: 0;`,
      `  padding: 16px;`,
      `  font-size: 12px;`,
      `  line-height: 18px;`,
      `  max-height: min(480px, 60vh);`,
      `  overflow-y: auto;`,
      `}`,
      `.${NS}-panel-head { display: flex; flex-direction: column; gap: 2px; margin-bottom: 8px; }`,
      `.${NS}-panel-title { color: var(--dsw-alias-label-primary); font-weight: 500; font-size: 12px; display: flex; justify-content: space-between; gap: 16px; }`,
      `.${NS}-panel-sub { color: var(--dsw-alias-label-tertiary); font-size: 11px; margin-bottom: 8px; }`,
      `.${NS}-panel-head::after { content: ""; border-top: 0.5px solid var(--dsw-alias-border-l2); margin-bottom: 10px; }`,
    ].join("\n");

    function WarningIcon() {
      return h(
        "svg",
        {
          viewBox: "0 0 16 16",
          width: 15,
          height: 15,
          "aria-hidden": true,
          style: { display: "inline-block", verticalAlign: "-2px" },
        },
        h(
          "path",
          {
            d: "M8 1.5 L15 14 L1 14 Z",
            fill: "none",
            stroke: "var(--dsw-alias-state-warn-primary)",
            strokeWidth: 1.4,
            strokeLinejoin: "round",
          },
        ),
        h("line", {
          x1: 8, y1: 6, x2: 8, y2: 10,
          stroke: "var(--dsw-alias-state-warn-primary)",
          strokeWidth: 1.4,
          strokeLinecap: "round",
        }),
        h("circle", { cx: 8, cy: 12, r: 0.7, fill: "var(--dsw-alias-state-warn-primary)" }),
      );
    }

    // Parse the model-facing text back into card data.
    function parseReminder(text) {
      const rules = [];
      const pattern = /<system-interrupt[^>]*?rule="([^"]*)"(?:[^>]*?matched="([^"]*)")?[^>]*>\n?([\s\S]*?)<\/system-interrupt>/g;
      let match;
      while ((match = pattern.exec(text)) !== null) {
        rules.push({ name: match[1], matched: match[2], message: match[3].trim() });
      }
      return rules;
    }

    function TtsrReminderCard(props) {
      const node = props?.node;
      const data = node?.data ?? {};
      const t = props?.t ?? ((key) => dictionaries.en[key] ?? key);
      const observe = data.mode === "observe";
      const soft = data.mode === "soft";
      const cont = data.mode === "continue";
      const rules = Array.isArray(data.rules) && data.rules.length > 0 ? data.rules : [{ name: "?", matched: undefined, message: undefined }];

      return h(
        "section",
        { className: `${NS}-card`, "data-ttsr-reminder": String(node?.id ?? "") },
        h(
          "style",
          null,
          CARD_CSS,
        ),
        h(
          "div",
          { className: `${NS}-head` },
          h("span", { className: `${NS}-icon` }, h(WarningIcon)),
          h(
            "span",
            { className: `${NS}-title` },
            t(soft ? "softTitle" : cont ? "continueTitle" : observe ? "observeTitle" : "cardTitle"),
          ),
        ),
        rules.map((rule, index) =>
          h(
            "div",
            { key: `${rule.name}-${index}`, className: `${NS}-rule` },
            h("div", { className: `${NS}-rulename` }, `${t("ruleLabel")}: ${rule.name}`),
            rule.matched
              ? h("div", { className: `${NS}-excerpt` }, `${t("matched")}: ${rule.matched}`)
              : null,
            rule.message ? h("div", { className: `${NS}-message` }, rule.message) : null,
          ),
        ),
        h("div", { className: `${NS}-note` }, t(soft ? "softNote" : cont ? "continueNote" : observe ? "observeNote" : "retryNote")),
      );
    }

    const inject = ["uiConversation", "slots", "locale", "remote", "remote.commands"];

    function apply(ctx) {
      try {
      ctx.effect(() => ctx.locale.register(NS, dictionaries), `${NS}: dictionaries`);

      ctx.uiConversation.events.register({
        kind: NODE_KIND,
        target: "chat",
        match: (event) => {
          if (event.type !== "user/message") return null;
          if (event.surfaceOp !== "append") return null; // skip compaction replacement copies
          const message = event.data;
          if (message?.source?.kind !== REMINDER_SOURCE) return null;
          // exclusive: claim the event so the default input-message fold (which
          // would build a hidden context row) and the unknown-surface fallback
          // do not also fold this event.
          return { id: String(message.id ?? event.seq), role: "start", exclusive: true };
        },
        start: (_context, match) => {
          const message = match.event.data;
          const text = String(
            (message.content ?? []).find((block) => block?.type === "text")?.text ?? "",
          );
          const parsed = parseReminder(text);
          const names = Array.isArray(message.source?.rules)
            ? message.source.rules.filter((entry) => typeof entry === "string")
            : parsed.map((rule) => rule.name);
          const merged = names.map(
            (ruleName) => parsed.find((rule) => rule.name === ruleName) ?? { name: ruleName },
          );
          return {
            mode:
              message.source?.mode === "observe" || message.source?.mode === "soft" || message.source?.mode === "continue"
                ? message.source.mode
                : "interrupt",
            rules: merged,
          };
        },
        update: (context) => context.state,
        buildViewNode: (context) => {
          // A keyed update can arrive without its start (e.g. the start was
          // pruned by compaction, or the fold window begins mid-pair). The
          // shipped workflow-run definition returns null in this case; reading
          // context.start.event.seq unguarded kills the whole event feed.
          if (context.start === undefined) return null;
          return {
            key: context.key,
            kind: NODE_KIND,
            id: context.id,
            target: "chat",
            anchorSeq: context.start.event.seq,
            location: context.start.location,
            visibility: "visible",
            data: context.state,
          };
        },
      });

      ctx.slots.inject("conversation.chat.node", () =>
        ctx.slots.register(
          { name: "conversation.chat.node", key: NODE_KIND, locale: NS },
          TtsrReminderCard,
        ),
      );

      // ---- per-session rule panel (live toggle switches) ----------------------
    function parsePanelText(text) {
      if (typeof text !== "string") return null;
      if (text.startsWith(PANEL_PREFIX)) {
        try {
          return { hidden: false, rules: JSON.parse(text.slice(PANEL_PREFIX.length)).rules ?? [] };
        } catch {
          return null;
        }
      }
      if (text.startsWith(SET_PREFIX)) {
        try {
          return { hidden: true, rules: JSON.parse(text.slice(SET_PREFIX.length)).rules ?? [] };
        } catch {
          return null;
        }
      }
      return null;
    }

    function RuleSwitch(props) {
      const { on, disabled, onToggle, label } = props;
      return h(
        "button",
        {
          className: `${NS}-switch`,
          "data-on": String(on),
          role: "switch",
          "aria-checked": String(on),
          "aria-label": label,
          disabled: disabled === true,
          onClick: onToggle,
        },
        h("span", { className: `${NS}-switch-knob` }),
      );
    }

    // 14px outline icon matching the shipped primitives icon style (.pill svg).
    function TtsrIcon() {
      return h(
        "svg",
        {
          viewBox: "0 0 16 16",
          width: 14,
          height: 14,
          fill: "none",
          "aria-hidden": true,
          style: { display: "inline-flex" },
        },
        h("path", {
          d: "M8 1.5 L14 4.5 V8 C14 11.5 11.3 13.9 8 14.5 C4.7 13.9 2 11.5 2 8 V4.5 Z",
          stroke: "currentColor",
          strokeWidth: 1,
          strokeLinejoin: "round",
        }),
        h("path", {
          d: "M8.8 4.5 L6.2 8.5 H8 L7.2 11.5 L9.8 7.5 H8 Z",
          stroke: "currentColor",
          strokeWidth: 1,
          strokeLinejoin: "round",
        }),
      );
    }

    // The per-session rule panel lives in the composer dock: a small button
    // next to the input that opens the toggle panel. It talks to the Host
    // through the shipped commands Remote (/ttsr fetches state, /ttsr-set flips,
    // /ttsr-cfg reads and writes the settings).
    function TtsrDockPanel(props, ctxRef) {
      const ctx = ctxRef.current;
      const sessionId = props?.sessionId;
      const t = props?.t ?? ((key) => dictionaries.en[key] ?? key);
      const [open, setOpen] = React.useState(false);
      const [rules, setRules] = React.useState([]);
      const [busy, setBusy] = React.useState(null);
      const [error, setError] = React.useState(null);
      const [loading, setLoading] = React.useState(false);
      const [settingsOpen, setSettingsOpen] = React.useState(false);
      const [settings, setSettings] = React.useState(null);
      const [modelProviders, setModelProviders] = React.useState(null);
      const [modelList, setModelList] = React.useState(null);
      const [saving, setSaving] = React.useState(false);
      const [pingState, setPingState] = React.useState(null);
      const rootRef = React.useRef(null);

      const closePanel = () => {
        setOpen(false);
        setSettingsOpen(false);
      };

      React.useEffect(() => {
        if (!open) return;
        const onPointerDown = (event) => {
          const root = rootRef.current;
          if (root !== null && event.target instanceof Node && !root.contains(event.target)) {
            setOpen(false);
            setSettingsOpen(false);
          }
        };
        const onKeyDown = (event) => {
          if (event.key === "Escape") {
            setOpen(false);
            setSettingsOpen(false);
          }
        };
        document.addEventListener("pointerdown", onPointerDown, true);
        document.addEventListener("keydown", onKeyDown, true);
        return () => {
          document.removeEventListener("pointerdown", onPointerDown, true);
          document.removeEventListener("keydown", onKeyDown, true);
        };
      }, [open]);

      const runCommand = async (line) => {
        const remote = ctx?.remote;
        const execute = remote?.commands?.execute;
        if (typeof execute !== "function") throw new Error("commands remote is unavailable");
        const execution = await execute(sessionId, line, [], undefined);
        const outcome = execution?.ok === true && execution?.value !== undefined ? execution.value : execution;
        return outcome?.result?.text ?? outcome?.text ?? "";
      };

      const load = async () => {
        setLoading(true);
        setError(null);
        try {
          const text = await runCommand("/ttsr");
          const parsed = parsePanelText(text);
          if (parsed !== null && Array.isArray(parsed.rules) && parsed.rules.length > 0) setRules(parsed.rules);
          else if (text.startsWith("TTSR: no rules")) setRules([]);
          else setError(String(text.slice(0, 120)));
        } catch (cause) {
          setError(String(cause?.message ?? cause));
        } finally {
          setLoading(false);
        }
      };

      const loadSettings = async () => {
        setError(null);
        try {
          const text = await runCommand("/ttsr-cfg get");
          if (!text.startsWith(CONFIG_PREFIX)) {
            setError(String(text.slice(0, 120)));
            return;
          }
          const snapshot = JSON.parse(text.slice(CONFIG_PREFIX.length));
          setSettings({
            enabled: snapshot.enabled === true,
            monitorSubagents: snapshot.monitorSubagents === true,
            maxRetriesPerStep: String(snapshot.maxRetriesPerStep ?? 2),
            retryDelayMs: String(snapshot.retryDelayMs ?? 300),
            model: typeof snapshot.model === "string" ? snapshot.model : null,
            generator:
              snapshot.generator !== null && typeof snapshot.generator === "object"
                ? { provider: String(snapshot.generator.provider ?? ""), model: String(snapshot.generator.model ?? "") }
                : null,
            judge: {
              kind: snapshot.judge?.kind === "chat" ? "chat" : "qev",
              baseUrl: String(snapshot.judge?.baseUrl ?? ""),
              threshold: String(snapshot.judge?.threshold ?? 0.6),
              hardThreshold: String(snapshot.judge?.hardThreshold ?? 0.75),
            },
          });
          // Provider list for the generator picker (best effort).
          runCommand("/ttsr-cfg models")
            .then((text2) => {
              if (text2.startsWith(CONFIG_PREFIX)) {
                const parsed = JSON.parse(text2.slice(CONFIG_PREFIX.length));
                if (Array.isArray(parsed.providers)) setModelProviders(parsed.providers);
              }
            })
            .catch(() => {});
          // Preload the model list when a generator is already configured.
          if (typeof snapshot.generator?.provider === "string" && snapshot.generator.provider.length > 0) {
            runCommand(`/ttsr-cfg models ${snapshot.generator.provider}`)
              .then((text2) => {
                if (text2.startsWith(CONFIG_PREFIX)) {
                  const parsed = JSON.parse(text2.slice(CONFIG_PREFIX.length));
                  if (Array.isArray(parsed.models)) setModelList(parsed.models);
                }
              })
              .catch(() => {});
          }
        } catch (cause) {
          setError(String(cause?.message ?? cause));
        }
      };

      React.useEffect(() => {
        if (open && rules.length === 0 && loading === false) load();
      }, [open]);

      const applyRulePayload = (text) => {
        const parsed = parsePanelText(text);
        if (parsed !== null && Array.isArray(parsed.rules) && parsed.rules.length > 0) {
          setRules(parsed.rules);
          return true;
        }
        setError(String(text.slice(0, 140)));
        return false;
      };

      const onToggle = (rule) => {
        if (busy !== null || sessionId === undefined) return;
        setBusy(rule.name);
        setError(null);
        setRules((current) => current.map((entry) => (entry.name === rule.name ? { ...entry, muted: !entry.muted } : entry)));
        runCommand(`/ttsr-set ${rule.name} ${rule.muted ? "on" : "off"}`)
          .then((text) => {
            applyRulePayload(text);
          })
          .catch((cause) => {
            setError(String(cause?.message ?? cause));
            setRules((current) => current.map((entry) => (entry.name === rule.name ? { ...entry, muted: rule.muted } : entry)));
          })
          .finally(() => setBusy(null));
      };

      const allMuted = rules.length > 0 && rules.every((rule) => rule.muted === true);
      const onToggleAll = () => {
        if (busy !== null || sessionId === undefined || rules.length === 0) return;
        setBusy("__all__");
        setError(null);
        setRules((current) => current.map((entry) => ({ ...entry, muted: !allMuted })));
        runCommand(allMuted ? "/ttsr on" : "/ttsr mute")
          .then((text) => {
            applyRulePayload(text);
          })
          .catch((cause) => {
            setError(String(cause?.message ?? cause));
            setRules((current) => current.map((entry) => ({ ...entry, muted: allMuted })));
          })
          .finally(() => setBusy(null));
      };

      const updateSettings = (path, value) => {
        setSettings((current) => {
          if (current === null) return current;
          if (path.startsWith("judge.")) {
            return { ...current, judge: { ...current.judge, [path.slice(6)]: value } };
          }
          return { ...current, [path]: value };
        });
      };

      const onGeneratorProvider = (provider) => {
        updateSettings("generator", provider.length === 0 ? null : { provider, model: "" });
        setModelList(null);
        if (provider.length === 0) return;
        runCommand(`/ttsr-cfg models ${provider}`)
          .then((text) => {
            if (text.startsWith(CONFIG_PREFIX)) {
              const parsed = JSON.parse(text.slice(CONFIG_PREFIX.length));
              if (Array.isArray(parsed.models)) setModelList(parsed.models);
            }
          })
          .catch(() => {});
      };

      const onSaveSettings = () => {
        if (settings === null || saving) return;
        setSaving(true);
        setError(null);
        setPingState(null);
        const patch = {
          enabled: settings.enabled === true,
          monitorSubagents: settings.monitorSubagents === true,
          maxRetriesPerStep: Number(settings.maxRetriesPerStep),
          retryDelayMs: Number(settings.retryDelayMs),
          judge: {
            kind: settings.judge.kind,
            baseUrl: settings.judge.baseUrl,
            threshold: Number(settings.judge.threshold),
            hardThreshold: Number(settings.judge.hardThreshold),
          },
          generator:
            settings.generator !== null &&
            typeof settings.generator === "object" &&
            typeof settings.generator.provider === "string" &&
            settings.generator.provider.length > 0 &&
            typeof settings.generator.model === "string" &&
            settings.generator.model.length > 0
              ? { provider: settings.generator.provider, model: settings.generator.model }
              : null,
        };
        runCommand(`/ttsr-cfg write ${JSON.stringify(patch)}`)
          .then((text) => {
            if (text.startsWith(CONFIG_PREFIX)) {
              const snapshot = JSON.parse(text.slice(CONFIG_PREFIX.length));
              setPingState({ detail: snapshot.saved === true ? t("saved") : "", ok: snapshot.saved === true });
            } else {
              setError(String(text.slice(0, 140)));
            }
          })
          .catch((cause) => setError(String(cause?.message ?? cause)))
          .finally(() => setSaving(false));
      };

      const onPing = () => {
        if (sessionId === undefined) return;
        setPingState({ detail: "…", ok: false });
        runCommand("/ttsr-cfg ping")
          .then((text) => {
            if (!text.startsWith(CONFIG_PREFIX)) {
              setPingState({ detail: String(text.slice(0, 100)), ok: false });
              return;
            }
            const payload = JSON.parse(text.slice(CONFIG_PREFIX.length));
            setPingState({
              detail: payload.ping?.reachable === true ? `${t("reachable")} (${payload.ping.baseUrl})` : `${t("unreachable")}: ${payload.ping?.detail ?? "?"}`,
              ok: payload.ping?.reachable === true,
            });
          })
          .catch((cause) => setPingState({ detail: String(cause?.message ?? cause), ok: false }));
      };

      const openSettings = () => {
        const next = !settingsOpen;
        setSettingsOpen(next);
        if (next && settings === null) loadSettings();
      };

      const field = (label, control) =>
        h(
          "div",
          { className: `${NS}-field` },
          h("span", { className: `${NS}-field-label` }, label),
          control,
        );

      const renderSettings = () =>
        h(
          "div",
          null,
          h("div", { className: `${NS}-hint` }, t("settingsHint")),
          field(
            t("fieldModel"),
            h("span", { className: `${NS}-status` }, settings?.model ?? t("fieldModelExternal")),
          ),
          field(
            t("fieldGenerator"),
            h(
              "div",
              { className: `${NS}-generator` },
              h(
                "select",
                {
                  className: `${NS}-select`,
                  value: settings?.generator?.provider ?? "",
                  onChange: (event) => onGeneratorProvider(event.target.value),
                },
                h("option", { value: "" }, t("generatorSession")),
                (modelProviders ?? []).map((provider) =>
                  h("option", { key: provider, value: provider }, provider),
                ),
              ),
              settings?.generator?.provider
                ? h(
                    "select",
                    {
                      className: `${NS}-select`,
                      value: settings?.generator?.model ?? "",
                      onChange: (event) =>
                        updateSettings("generator", {
                          provider: settings.generator.provider,
                          model: event.target.value,
                        }),
                    },
                    h("option", { value: "" }, "—"),
                    (modelList ?? []).map((model) => h("option", { key: model, value: model }, model)),
                  )
                : null,
            ),
          ),
          h("div", { className: `${NS}-hint` }, t("generatorHint")),
          field(
            t("fieldKind"),
            h(
              "select",
              {
                className: `${NS}-select`,
                value: settings?.judge.kind ?? "qev",
                onChange: (event) => updateSettings("judge.kind", event.target.value),
              },
              h("option", { value: "qev" }, "qev (local)"),
              h("option", { value: "chat" }, "chat (LLM)"),
            ),
          ),
          field(
            t("fieldBaseUrl"),
            h("input", {
              className: `${NS}-input`,
              type: "text",
              value: settings?.judge.baseUrl ?? "",
              onChange: (event) => updateSettings("judge.baseUrl", event.target.value),
            }),
          ),
          field(
            t("fieldThreshold"),
            h("input", {
              className: `${NS}-input`,
              type: "number",
              step: "0.05",
              min: "0.5",
              max: "0.95",
              value: settings?.judge.threshold ?? "",
              onChange: (event) => updateSettings("judge.threshold", event.target.value),
            }),
          ),
          field(
            t("fieldHardThreshold"),
            h("input", {
              className: `${NS}-input`,
              type: "number",
              step: "0.05",
              min: "0.5",
              max: "0.99",
              value: settings?.judge.hardThreshold ?? "",
              onChange: (event) => updateSettings("judge.hardThreshold", event.target.value),
            }),
          ),
          field(
            t("fieldMaxRetries"),
            h("input", {
              className: `${NS}-input`,
              type: "number",
              step: "1",
              min: "0",
              max: "10",
              value: settings?.maxRetriesPerStep ?? "",
              onChange: (event) => updateSettings("maxRetriesPerStep", event.target.value),
            }),
          ),
          field(
            t("fieldRetryDelay"),
            h("input", {
              className: `${NS}-input`,
              type: "number",
              step: "100",
              min: "0",
              max: "30000",
              value: settings?.retryDelayMs ?? "",
              onChange: (event) => updateSettings("retryDelayMs", event.target.value),
            }),
          ),
          field(
            t("fieldMonitorSubagents"),
            h(RuleSwitch, {
              on: settings?.monitorSubagents === true,
              onToggle: () => updateSettings("monitorSubagents", !(settings?.monitorSubagents === true)),
              label: t("fieldMonitorSubagents"),
            }),
          ),
          field(
            t("fieldEnabled"),
            h(RuleSwitch, {
              on: settings?.enabled === true,
              onToggle: () => updateSettings("enabled", !(settings?.enabled === true)),
              label: t("fieldEnabled"),
            }),
          ),
          h(
            "div",
            { className: `${NS}-actions` },
            h(
              "button",
              { className: `${NS}-btn`, type: "button", disabled: saving || settings === null, onClick: onSaveSettings },
              saving ? "…" : t("save"),
            ),
            h("button", { className: `${NS}-btn`, type: "button", onClick: onPing }, t("testQev")),
            pingState !== null
              ? h("span", { className: `${NS}-status`, "data-ok": String(pingState.ok === true) }, pingState.detail)
              : null,
          ),
        );

      if (sessionId === undefined) return null;
      const disabledCount = rules.filter((rule) => rule.muted === true).length;
      return h(
        "span",
        { className: `${NS}-dock`, "data-composer-stat": "ttsr", ref: rootRef },
        h("style", null, CARD_CSS),
        h(
          "button",
          {
            className: `${NS}-dock-btn`,
            type: "button",
            "aria-haspopup": "dialog",
            "aria-expanded": String(open),
            onClick: () => {
              if (!open && rules.length === 0) load();
              if (open) closePanel();
              else setOpen(true);
            },
          },
          h(TtsrIcon),
          h("span", { className: `${NS}-dock-label` }, t("dockButton")),
        ),
        open
          ? h(
              "div",
              { className: `${NS}-panel`, role: "dialog", "aria-label": t("panelTitle") },
              h(
                "div",
                { className: `${NS}-panel-head` },
                h(
                  "div",
                  { style: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 } },
                  h("span", { className: `${NS}-panel-title` }, settingsOpen ? t("settingsTitle") : t("panelTitle")),
                  h(
                    "button",
                    {
                      className: `${NS}-gear`,
                      type: "button",
                      "aria-pressed": String(settingsOpen),
                      "aria-label": t("settingsTitle"),
                      title: t("settingsTitle"),
                      onClick: openSettings,
                    },
                    h(
                      "svg",
                      { width: 14, height: 14, viewBox: "0 0 16 16", fill: "none", "aria-hidden": true },
                      // Sliders/controls mark — reads as settings, not a theme toggle.
                      h("path", {
                        d: "M2 4.5h1.9M6.9 4.5h7.1M2 8h6.5M12.1 8h1.9M2 11.5h8.1M13.7 11.5h0.3",
                        stroke: "currentColor",
                        strokeWidth: 1.1,
                        strokeLinecap: "round",
                      }),
                      h("circle", { cx: 5.4, cy: 4.5, r: 1.6, stroke: "currentColor", strokeWidth: 1.1 }),
                      h("circle", { cx: 10.6, cy: 8, r: 1.6, stroke: "currentColor", strokeWidth: 1.1 }),
                      h("circle", { cx: 11.9, cy: 11.5, r: 1.6, stroke: "currentColor", strokeWidth: 1.1 }),
                    ),
                  ),
                ),
                h(
                  "span",
                  { className: `${NS}-panel-sub` },
                  error !== null ? error : loading ? "…" : settingsOpen ? t("settingsHint") : t("panelNote"),
                ),
              ),
              settingsOpen
                ? renderSettings()
                : h(
                    "div",
                    null,
                    rules.length > 0
                      ? h(
                          "div",
                          { className: `${NS}-panel-master` },
                          h(
                            "div",
                            { style: { display: "flex", flexDirection: "column", minWidth: 0 } },
                            h("span", { className: `${NS}-panel-master-label` }, t("toggleAll")),
                            h(
                              "span",
                              { className: `${NS}-panel-count` },
                              `${disabledCount}/${rules.length} ${t("disabledSuffix")}`,
                            ),
                          ),
                          h(RuleSwitch, {
                            on: !allMuted,
                            disabled: busy === "__all__",
                            onToggle: onToggleAll,
                            label: t("toggleAll"),
                          }),
                        )
                      : null,
                    rules.length === 0 && loading === false
                      ? h("span", { className: `${NS}-panel-sub` }, t("noRules"))
                      : rules.map((rule) =>
                          h(
                            "div",
                            { key: rule.name, className: `${NS}-panel-row` },
                            h(
                              "div",
                              { style: { display: "flex", flexDirection: "column", minWidth: 0 } },
                              h("span", { className: `${NS}-panel-name` }, rule.name),
                              typeof rule.trigger === "string" && rule.trigger.length > 0
                                ? h("span", { className: `${NS}-panel-trigger` }, rule.trigger)
                                : null,
                            ),
                            h(RuleSwitch, {
                              on: rule.muted !== true,
                              disabled: busy === rule.name || busy === "__all__",
                              onToggle: () => onToggle(rule),
                              label: rule.name,
                            }),
                          ),
                        ),
                  ),
            )
          : null,
      );
    }

      // Claim the panel-backend command events (ttsr bare + ttsr-set) as hidden
      // chat nodes: they render no command rows; the UI lives in the composer dock.
      ctx.uiConversation.events.register({
        kind: PANEL_KIND,
        target: "chat",
        match: (event) => {
          if (event.type === "command/run") {
            const name = event.data?.name;
            if (name === "ttsr" && !PANEL_SUBCOMMANDS.test(String(event.data?.args ?? ""))) {
              return { id: String(event.data.commandId), role: "start", exclusive: true };
            }
            if (name === "ttsr-set") return { id: String(event.data.commandId), role: "start", exclusive: true };
            return null;
          }
          if (event.type === "command/done") {
            const text = String(event.data?.text ?? "");
            if (!text.startsWith(PANEL_PREFIX) && !text.startsWith(SET_PREFIX)) return null;
            return { id: String(event.data.commandId), role: "update", exclusive: true };
          }
          return null;
        },
        start: () => ({ hidden: true }),
        update: (context) => context.state,
        buildViewNode: (context) => {
          // A done can outlive its run (the run event pruned by compaction);
          // folding that startless update must not throw.
          if (context.start === undefined) return null;
          return {
            key: context.key,
            kind: HIDDEN_KIND,
            id: context.id,
            target: "chat",
            anchorSeq: context.start.event.seq,
            location: context.start.location,
            visibility: "hidden",
            data: {},
          };
        },
      });

      // The rule panel itself: a composer-dock entry (popup beside the input).
      const ctxRef = { current: ctx };
      ctx.slots.inject("conversation.composer.dock", () =>
        ctx.slots.register(
          { name: "conversation.composer.dock", id: "ttsr-rules", order: 5, label: "TTSR rules" },
          (props) => TtsrDockPanel(props, ctxRef),
        ),
      );
      } catch (applyError) {
        console.error("[ttsr-module] apply failed:", applyError);
      }
    }

    const module = { exports: {} };
    module.exports.apply = apply;
    module.exports.inject = inject;
    return module.exports;
  },
});
