import {
  compilePattern,
  matchTokens,
  tokenize,
  globToRegExp,
  matchesGlobs,
  extractSources,
  hasCodeExtension,
  pathFromPartialJson,
} from "./ast-matcher.js";

let failed = 0;
const assert = (cond, name) => {
  if (!cond) {
    console.error("FAIL: " + name);
    failed += 1;
  } else {
    console.log("ok: " + name);
  }
};

// ---- globs ----
const g1 = globToRegExp("*.ts");
assert(g1.test("foo.ts") === true, "glob *.ts matches foo.ts");
assert(g1.test("src/foo.ts") === false, "glob *.ts does not match full path");
const g2 = globToRegExp("src/**/*.ts");
assert(g2.test("src/foo.ts") === true, "src/**/*.ts matches zero extra segments");
assert(g2.test("src/a/b/foo.ts") === true, "src/**/*.ts matches nested");
assert(g2.test("lib/foo.ts") === false, "src/**/*.ts rejects other root");
assert(matchesGlobs([g1], "src/foo.ts") === true, "basename fallback matches");
assert(matchesGlobs([g1], "src/foo.md") === false, "basename mismatch rejected");
assert(globToRegExp("**/*.py").test("a/b/x.py") === true, "**/*.py matches nested");

// ---- patterns ----
const p1 = compilePattern("console.log($$$ARGS)");
assert(p1.ok, "pattern compiles");
assert(matchTokens(p1.items, tokenize('function f() { console.log("x", 1); }')) !== null, "call with args matches");
assert(matchTokens(p1.items, tokenize("function f() { system.log(1); }")) === null, "different callee rejected");
assert(matchTokens(p1.items, tokenize("x = console.log()")) !== null, "empty span matches");
const p2 = compilePattern("Box::leak($$$)");
assert(matchTokens(p2.items, tokenize("let s: &str = Box::leak(b.as_ptr());")) !== null, "Box::leak matches");
assert(matchTokens(p2.items, tokenize("let s = Box::new(x);")) === null, "Box::new rejected");
assert(matchTokens(p2.items, tokenize("Box :: leak ( ptr )")) !== null, "whitespace-insensitive");
const p3 = compilePattern("let $X = $X + 1");
assert(matchTokens(p3.items, tokenize("let i = i + 1")) !== null, "unified metavar matches");
assert(matchTokens(p3.items, tokenize("let i = j + 1")) === null, "inconsistent metavar rejected");
assert(compilePattern("a b").ok && compilePattern("").ok === false, "empty pattern rejected");
assert(compilePattern("$x").ok === false || compilePattern("$x").items.every((i) => i.kind === "literal"), "lowercase $ stays literal");

// ---- extractSources ----
const s1 = extractSources({ file_path: "a.ts", new_string: "console.log(1)" });
assert(s1.length === 1 && s1[0].path === "a.ts" && s1[0].content === "console.log(1)", "edit new_string extracted");
const s2 = extractSources({ path: "b.py", content: "x=1" });
assert(s2.length === 1 && s2[0].content === "x=1", "write content extracted");
const s3 = extractSources({ file_path: "c.ts", edits: [{ path: "d.ts", new_string: "e()" }, { new_string: "f()" }] });
assert(s3.length === 2 && s3[0].path === "d.ts" && s3[1].path === "c.ts", "nested edits extracted (got " + s3.length + ")");
assert(extractSources(null).length === 0 && extractSources([1, 2]).length === 0, "non-object args rejected");

// ---- gates ----
assert(hasCodeExtension("x/foo.TS") === true && hasCodeExtension("x/readme") === false, "code extension gate");
assert(pathFromPartialJson('{"file_path":"src/a.ts","new_') === "src/a.ts", "partial JSON path extraction");
assert(pathFromPartialJson('{"other":1}') === null, "no path returns null");

console.log(failed === 0 ? "ALL TESTS PASSED" : failed + " FAILURES");
process.exit(failed === 0 ? 0 : 1);
