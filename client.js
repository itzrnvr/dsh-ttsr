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

    const dictionaries = {
      en: {
        cardTitle: "Stream rule injected",
        observeTitle: "Stream rule matched",
        retryNote: "The violating attempt was discarded and the step was retried with this rule applied.",
        observeNote: "The output was not interrupted; this reminder was injected for the next step.",
        matched: "matched",
        ruleLabel: "rule",
      },
      zh: {
        cardTitle: "已注入流规则",
        observeTitle: "命中流规则",
        retryNote: "违规输出已被丢弃，并在应用该规则后重试了本步骤。",
        observeNote: "输出未被中断；该提醒已注入供下一步使用。",
        matched: "命中",
        ruleLabel: "规则",
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
          h("span", { className: `${NS}-title` }, t(observe ? "observeTitle" : "cardTitle")),
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
        h("div", { className: `${NS}-note` }, t(observe ? "observeNote" : "retryNote")),
      );
    }

    const inject = ["uiConversation", "slots", "locale"];

    function apply(ctx) {
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
            mode: message.source?.mode === "observe" ? "observe" : "interrupt",
            rules: merged,
          };
        },
        update: (context) => context.state,
        buildViewNode: (context) => ({
          key: context.key,
          kind: NODE_KIND,
          id: context.id,
          target: "chat",
          anchorSeq: context.start.event.seq,
          location: context.start.location,
          visibility: "visible",
          data: context.state,
        }),
      });

      ctx.slots.inject("conversation.chat.node", () =>
        ctx.slots.register(
          { name: "conversation.chat.node", key: NODE_KIND, locale: NS },
          TtsrReminderCard,
        ),
      );
    }

    const module = { exports: {} };
    module.exports.apply = apply;
    module.exports.inject = inject;
    return module.exports;
  },
});
