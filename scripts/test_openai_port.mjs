// The OpenAI port (scripts/openai_port.mjs, d1a#274) in front of a stand-in model server: only chat, embeddings and the
// model list pass, a stream arrives piece by piece, and a model server that is down is a 502. Run: node --test scripts/
import assert from "node:assert/strict";
import http from "node:http";
import { test } from "node:test";
import { allowed, createProxy } from "./openai_port.mjs";

test("only the three OpenAI routes pass, by exact path", () => {
  assert.ok(allowed("POST", "/v1/chat/completions") && allowed("POST", "/v1/embeddings") && allowed("GET", "/v1/models"));
  assert.ok(allowed("GET", "/v1/models?x=1"));
  for (const [m, u] of [["POST", "/v1/systemone"], ["POST", "/v1/systemone/media"], ["POST", "/v1/feedback"], ["GET", "/v1/chat/completions"],
                        ["POST", "/v1/chat/completions/../../systemone"], ["POST", "//v1/chat/completions"], ["POST", "/v1/chat%2Fcompletions"],
                        ["GET", "/v1/./models"], ["GET", "/v1/systemone/../models"], ["GET", "/"], ["DELETE", "/v1/models"]])
    assert.equal(allowed(m, u), false, `${m} ${u}`);
});

function listen(server) { return new Promise((ok) => server.listen(0, "127.0.0.1", () => ok(`http://127.0.0.1:${server.address().port}`))); }

test("requests reach the model server, streams come back as they are written, other routes never do", async (t) => {
  const seen = [];
  let release;
  const model = http.createServer((req, res) => {
    let body = ""; req.on("data", (c) => (body += c));
    req.on("end", () => {
      seen.push(`${req.method} ${req.url} ${body}`);
      if (req.url === "/v1/chat/completions") {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write("data: first\n\n");
        release = () => res.end("data: [DONE]\n\n");   // the second piece only after the client has the first
      } else { res.writeHead(200, { "content-type": "application/json" }); res.end('{"object":"list"}'); }
    });
  });
  const upstream = await listen(model), proxy = createProxy(upstream), base = await listen(proxy);
  t.after(() => { proxy.close(); model.close(); });

  assert.equal((await (await fetch(`${base}/v1/models`)).json()).object, "list");
  const blocked = await fetch(`${base}/v1/systemone`, { method: "POST", body: "{}" });
  assert.equal(blocked.status, 404);
  const r = await fetch(`${base}/v1/chat/completions`, { method: "POST", body: '{"stream":true}', headers: { "content-type": "application/json" } });
  assert.equal(r.headers.get("content-type"), "text/event-stream");
  const reader = r.body.getReader(), dec = new TextDecoder();
  assert.equal(dec.decode((await reader.read()).value), "data: first\n\n");
  release();
  let rest = ""; for (let c; !(c = await reader.read()).done;) rest += dec.decode(c.value);
  assert.equal(rest, "data: [DONE]\n\n");
  assert.deepEqual(seen, ["GET /v1/models ", 'POST /v1/chat/completions {"stream":true}']);
});

test("a model server that is down is a 502 with an OpenAI error body", async (t) => {
  const gone = http.createServer(); const upstream = await listen(gone); await new Promise((ok) => gone.close(ok));
  const proxy = createProxy(upstream), base = await listen(proxy);
  t.after(() => proxy.close());
  const r = await fetch(`${base}/v1/embeddings`, { method: "POST", body: '{"input":"x"}' });
  assert.equal(r.status, 502);
  assert.match((await r.json()).error.message, /not answering/);
});
