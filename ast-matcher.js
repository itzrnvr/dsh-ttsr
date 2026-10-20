// ============================================================================
// @local/dsh-ttsr — structural pattern and glob matching utilities.
//
// astCondition patterns are code snippets with metavariables, matched against
// the token stream of the code a tool call writes (edit new_string / write
// content). This is a token-structural approximation of ast-grep: it does not
// build a parse tree, so it cannot respect statement boundaries, but it does
// enforce metavariable unification and is immune to formatting and whitespace.
//
//   $NAME   matches exactly one token; repeated $NAME must bind the same text
//   $_      matches any single token (anonymous)
//   $$$NAME matches a span of zero or more tokens (anonymous form: $$$)
//
// Example: `console.log($$$ARGS)` matches `console.log("x", 1)` and
// `console.log()`; `Box::leak($$$)` matches `Box::leak(x)`.
// ============================================================================

const TOKEN_RE = /"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`|\d[\w.]*|[A-Za-z_$][\w$]*|\s+|./g;

/** One lexical token of source or pattern text. */
function tokenize(text) {
  const tokens = [];
  const capped = text.length > 512 * 1024 ? text.slice(0, 512 * 1024) : text;
  for (const match of capped.matchAll(TOKEN_RE)) {
    const raw = match[0];
    if (/^\s+$/.test(raw)) continue;
    if (raw.length === 1 && !/[\w$]/.test(raw)) tokens.push({ text: raw, type: "punct" });
    else if (/^["'`]/.test(raw)) tokens.push({ text: raw, type: "str" });
    else if (/^\d/.test(raw)) tokens.push({ text: raw, type: "num" });
    else tokens.push({ text: raw, type: "ident" });
  }
  return tokens;
}

const METAVAR_RE = /^(\${1,3})(?:([A-Z][A-Z0-9_]*))?$/;

/**
 * Split a pattern into literal tokens and metavariables.
 * @param {string} pattern - the astCondition source text.
 * @returns {{ ok: true, items: object[] } | { ok: false, error: string }}
 */
function compilePattern(pattern) {
  if (typeof pattern !== "string" || pattern.trim().length === 0) return { ok: false, error: "pattern must be a non-empty string" };
  const tokens = tokenize(pattern);
  if (tokens.length === 0) return { ok: false, error: "pattern has no tokens" };
  const items = [];
  for (const token of tokens) {
    const metavar = token.type === "ident" ? METAVAR_RE.exec(token.text) : null;
    if (metavar === null) {
      items.push({ kind: "literal", text: token.text, type: token.type });
      continue;
    }
    const sigil = metavar[1];
    const name = metavar[2] ?? "_";
    if (sigil === "$$$") items.push({ kind: "span", name });
    else items.push({ kind: "single", name });
  }
  const spans = items.filter((item) => item.kind === "span").length;
  if (spans > 4) return { ok: false, error: "pattern uses more than 4 span metavariables" };
  return { ok: true, items };
}

/**
 * Match compiled pattern items against a slice of content tokens, with
 * metavariable unification. Mutates `bindings` while backtracking.
 * @returns {number} end index in contentTokens, or -1 when the rest cannot match.
 */
function matchFrom(items, itemIndex, contentTokens, contentIndex, bindings) {
  if (itemIndex === items.length) return contentIndex;
  const item = items[itemIndex];
  if (item.kind === "span") {
    for (let end = contentTokens.length; end >= contentIndex; end -= 1) {
      if (item.name !== "_") bindings.set(item.name, contentTokens.slice(contentIndex, end).map((token) => token.text));
      const next = matchFrom(items, itemIndex + 1, contentTokens, end, bindings);
      if (next !== -1) return next;
      if (item.name !== "_") bindings.delete(item.name);
    }
    return -1;
  }
  if (contentIndex >= contentTokens.length) return -1;
  const token = contentTokens[contentIndex];
  if (item.kind === "single") {
    const bound = bindings.get(item.name);
    if (bound !== undefined ? bound === token.text : true) {
      bindings.set(item.name, token.text);
      const next = matchFrom(items, itemIndex + 1, contentTokens, contentIndex + 1, bindings);
      if (next !== -1) return next;
      if (bound === undefined) bindings.delete(item.name);
    }
    return -1;
  }
  if (token.text === item.text) return matchFrom(items, itemIndex + 1, contentTokens, contentIndex + 1, bindings);
  return -1;
}

/**
 * Search a token stream for the pattern.
 * @param {object[]} items - compiled pattern items from compilePattern.
 * @param {object[]} contentTokens - tokenized candidate content.
 * @returns {{ startIndex: number, endIndex: number, text: string } | null}
 */
function matchTokens(items, contentTokens) {
  const cap = 40000;
  const tokens = contentTokens.length > cap ? contentTokens.slice(0, cap) : contentTokens;
  const firstLiteral = items.find((item) => item.kind === "literal");
  for (let start = 0; start < tokens.length; start += 1) {
    if (firstLiteral !== undefined && tokens[start].text !== firstLiteral.text) continue;
    const bindings = new Map();
    const end = matchFrom(items, 0, tokens, start, bindings);
    if (end !== -1) {
      return {
        startIndex: start,
        endIndex: end,
        text: tokens.slice(start, end).map((token) => token.text).join(" "),
      };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Source extraction from tool-call arguments
// ---------------------------------------------------------------------------

const CONTENT_KEYS = ["new_string", "content", "insert_str", "str_replace", "replacement", "text"];
const PATH_KEYS = ["file_path", "path"];

function firstString(record, keys) {
  for (const key of keys) {
    const value = record?.[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

/**
 * Extract the source-bearing payloads a tool call writes: pairs of
 * { path, content } from top-level and array-nested content fields.
 * @param {unknown} args - parsed tool arguments.
 * @returns {{ path: string, content: string }[]}
 */
function extractSources(args) {
  if (args === null || typeof args !== "object" || Array.isArray(args)) return [];
  const out = [];
  const seen = new Set();
  const push = (path, value) => {
    if (typeof value !== "string" || value.length === 0) return;
    const key = `${path ?? ""}\u0000${value}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ path: path ?? "", content: value });
  };
  const base = firstString(args, PATH_KEYS);
  for (const key of CONTENT_KEYS) push(base, args[key]);
  for (const value of Object.values(args)) {
    if (!Array.isArray(value)) continue;
    for (const item of value) {
      if (item === null || typeof item !== "object" || Array.isArray(item)) continue;
      const itemPath = firstString(item, PATH_KEYS) ?? base;
      for (const key of CONTENT_KEYS) push(itemPath, item[key]);
    }
  }
  return out;
}

/** Incrementally read a candidate path out of partially streamed tool-call argument JSON. */
function pathFromPartialJson(text) {
  const match = /"(?:file_path|path)"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(text);
  if (match === null) return null;
  try {
    return JSON.parse(`"${match[1]}"`);
  } catch {
    return match[1];
  }
}

const CODE_EXTENSIONS = new Set([
  "js", "jsx", "ts", "tsx", "mjs", "cjs", "mts", "cts", "py", "pyi", "rs", "go", "java", "kt", "kts",
  "c", "h", "cpp", "hpp", "cc", "cxx", "hh", "cs", "rb", "php", "swift", "scala", "sc", "sh", "bash",
  "zsh", "fish", "ps1", "psm1", "lua", "pl", "pm", "dart", "m", "mm", "v", "sv", "json", "jsonc",
  "yaml", "yml", "toml", "sql", "proto", "graphql", "gql", "vue", "svelte", "astro", "html", "htm",
]);

/** Whether a path carries a code-file extension usable for language gating. */
function hasCodeExtension(path) {
  const at = path.lastIndexOf(".");
  if (at < 0) return false;
  return CODE_EXTENSIONS.has(path.slice(at + 1).toLowerCase());
}

// ---------------------------------------------------------------------------
// Globs
// ---------------------------------------------------------------------------

function escapeSegment(segment) {
  let re = "";
  for (const ch of segment) {
    if (ch === "*") re += "[^/]*";
    else if (ch === "?") re += "[^/]";
    else re += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return re;
}

/**
 * Compile a file glob (`*`, `?` within a segment; a `**` segment matches zero
 * or more whole path segments) into a RegExp over forward-slash paths.
 */
function globToRegExp(glob) {
  const segments = String(glob).replace(/\\/g, "/").split("/");
  let trailingDouble = false;
  if (segments.length > 1 && segments[segments.length - 1] === "**") {
    trailingDouble = true;
    segments.pop();
  }
  let re = "";
  let previousWasDouble = false;
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    if (index > 0 && !previousWasDouble) re += "/";
    if (segment === "**") {
      re += "(?:[^/]+/)*";
      previousWasDouble = true;
    } else {
      re += escapeSegment(segment);
      previousWasDouble = false;
    }
  }
  if (trailingDouble) re += "(?:/.*)?";
  return new RegExp(`^${re}$`, "i");
}

/** Whether a candidate path satisfies one of the rule globs (path or basename). */
function matchesGlobs(globRegexes, path) {
  if (typeof path !== "string" || path.length === 0) return false;
  const normalized = path.replace(/\\/g, "/");
  const basename = normalized.slice(normalized.lastIndexOf("/") + 1);
  return globRegexes.some((regex) => regex.test(normalized) || (basename.length > 0 && regex.test(basename)));
}

export { compilePattern, extractSources, globToRegExp, hasCodeExtension, matchTokens, matchesGlobs, pathFromPartialJson, tokenize };
