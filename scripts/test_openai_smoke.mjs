// The live OpenAI check (scripts/openai_smoke.mjs, d1a#274) against stand-in servers: a server that answers as D1A does
// passes every check, and each way of breaking one fails that check. Run: node --test scripts/test_openai_smoke.mjs
import assert from "node:assert/strict";
import http from "node:http";
import { test } from "node:test";
import { run } from "./openai_smoke.mjs";

const unit = (v) => { const n = Math.hypot(...v); return v.map((x) => x / n); };
const EMBED = { "The cat sat on the mat.": unit([1, 0.1, 0]), "A cat is sitting on a mat.": unit([1, 0.2, 0]),
                "Quarterly revenue grew by eight percent.": unit([0, 0.1, 1]) };
const ANSWERS = { sev: { type: "choice", choice: "P1", probabilities: { P1: 0.6, P2: 0.4 } }, security: { type: "noul", noul: 0.97 } };

function reply(prompt, body) {   // what D1A-E2B-it says to the check's prompts
  if (body.tools) return { content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "get_weather", arguments: '{"city": "Tokyo"}' } }], finish: "tool_calls" };
  if (/pong/.test(prompt)) return { content: "Pong", finish: "stop" };
  if (/17 \+ 25/.test(prompt)) return { content: "42", finish: "stop" };
  if (/capital/.test(prompt)) return { content: '{"capital": "Tokyo"}', finish: "stop" };
  if (/1 to 10/.test(prompt)) return { content: "1, 2, 3, 4,", finish: "stop" };
  return { content: "1 2 3 4 5", finish: "stop" };
}

// break: names one fault to put in the stand-in
function standIn(brk = "") {
  let decisions = 0;
  return http.createServer((req, res) => {
    let raw = ""; req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = raw ? JSON.parse(raw) : {}, json = (s, j) => { res.writeHead(s, { "content-type": "application/json" }); res.end(JSON.stringify(j)); };
      const path = req.url;
      if (path === "/v1/models") return json(200, { object: "list", data: [{ id: "d1a-latest" }, { id: "d1a-chat" }, { id: "text-embedding-nomic-embed-text-v1.5" }] });
      if (path.startsWith("/v1/systemone") || path === "/v1/feedback") {
        if (req.headers["x-test-decide"] || brk === "systemone-open") {
          decisions++;
          const answers = brk === "decision-moves" && decisions > 1 ? { ...ANSWERS, security: { type: "noul", noul: 0.5 } } : ANSWERS;
          return json(200, { answers });
        }
        return json(404, { error: { message: "not served" } });
      }
      if (path === "/v1/embeddings") {
        const vec = (t) => (brk === "embed-random" ? unit([Math.random(), Math.random(), Math.random()]) : brk === "embed-unnormalized" ? EMBED[t].map((x) => 2 * x) : EMBED[t] || unit([0.3, 0.3, 0.3]));
        return json(200, { object: "list", data: body.input.map((t, i) => ({ object: "embedding", index: i, embedding: vec(t) })) });
      }
      if (path === "/v1/chat/completions") {
        const prompt = body.messages.map((m) => m.content).join("\n"), r = reply(prompt, body);
        if (brk === "chat-wrong" && /17 \+ 25/.test(prompt)) r.content = "41";
        if (brk === "tools-as-text" && body.tools) Object.assign(r, { content: "call:get_weather{city:Tokyo}", tool_calls: undefined, finish: "stop" });
        if (body.stream) {
          res.writeHead(200, { "content-type": brk === "stream-json" ? "application/json" : "text/event-stream" });
          const send = (delta, finish = null) => res.write(`data: ${JSON.stringify({ object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
          send({ role: "assistant", content: "" });
          for (const piece of r.content.split(" ")) send({ content: piece + " " });
          send({}, "stop");
          return res.end(brk === "stream-no-done" ? "" : "data: [DONE]\n\n");
        }
        return json(200, { object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content: r.content, ...(r.tool_calls && { tool_calls: r.tool_calls }) }, finish_reason: r.finish }] });
      }
      json(404, { error: { message: "not served" } });
    });
  });
}

async function check(brk) {
  const server = standIn(brk);
  await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
  const base = `http://127.0.0.1:${server.address().port}`, decide = `${base}/decide`, realFetch = globalThis.fetch;
  // the "model server" is the same stand-in: calls to <base>/decide/... go to <base>/... marked with a header
  globalThis.fetch = (url, init = {}) => String(url).startsWith(decide)
    ? realFetch(String(url).replace(decide, base), { ...init, headers: { ...init.headers, "x-test-decide": "1" } }) : realFetch(url, init);
  try {
    const { pass, results } = await run(base, { decide, log: () => {} });
    return { pass, failed: results.filter((r) => !r.ok).map((r) => r.name) };
  } finally { globalThis.fetch = realFetch; server.close(); }
}

test("a server that answers as D1A does passes every check", async () => {
  assert.deepEqual(await check(""), { pass: true, failed: [] });
});

for (const [brk, name] of [
  ["systemone-open", "System One and feedback not on this port"],
  ["chat-wrong", "chat answers a question"],
  ["stream-no-done", "streaming"],
  ["stream-json", "streaming"],
  ["tools-as-text", "tool call"],
  ["embed-random", "embeddings"],
  ["embed-unnormalized", "embeddings"],
  ["decision-moves", "decision unchanged after the chats"],
]) test(`${brk} fails "${name}"`, async () => {
  const { pass, failed } = await check(brk);
  assert.equal(pass, false);
  assert.ok(failed.includes(name), `failed: ${failed}`);
});

test("run through a symlink (macOS /tmp), both scripts still run as the main module instead of exiting 0 silently", async () => {
  const { spawnSync } = await import("node:child_process");
  const { mkdtempSync, symlinkSync, rmSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const dir = mkdtempSync(join(tmpdir(), "smoke-"));
  try {
    for (const name of ["openai_smoke.mjs", "openai_port.mjs"]) {
      symlinkSync(new URL(name, import.meta.url).pathname, join(dir, name));
      const r = spawnSync(process.execPath, [join(dir, name)], { encoding: "utf-8" });
      assert.equal(r.status, 2, `${name}: exit ${r.status}, ${r.stderr}`);   // no arguments: the usage line and exit 2
      assert.match(r.stderr, /usage/);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
