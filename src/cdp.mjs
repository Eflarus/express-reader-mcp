// Minimal Chrome DevTools Protocol client for the eXpress desktop app's Node inspector.
// The inspector (opened with SIGUSR1) exposes the MAIN process. We evaluate an
// expression there that drives the renderer via webContents.executeJavaScript.

const INSPECTOR_LIST = "http://127.0.0.1:9229/json/list";
const EVAL_TIMEOUT_MS = 25_000;

export async function portOpen() {
  try {
    const res = await fetch(INSPECTOR_LIST, { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch {
    return false;
  }
}

// Run `code` (a string of renderer-side JS) inside the eXpress window and return its value.
export async function evalRenderer(code) {
  const list = await (await fetch(INSPECTOR_LIST)).json();
  const target = list.find((t) => t.webSocketDebuggerUrl);
  if (!target) throw new Error("No inspector target (is the debug port open?)");

  const expression = `require('electron').webContents.fromId(1).executeJavaScript(${JSON.stringify(code)})`;
  const ws = new WebSocket(target.webSocketDebuggerUrl);

  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { try { ws.close(); } catch {} reject(new Error("Inspector eval timed out")); }, EVAL_TIMEOUT_MS);
    ws.onopen = () => ws.send(JSON.stringify({
      id: 1, method: "Runtime.evaluate",
      params: { expression, includeCommandLineAPI: true, awaitPromise: true, returnByValue: true },
    }));
    ws.onmessage = ({ data }) => {
      const message = JSON.parse(data);
      if (message.id !== 1) return;
      clearTimeout(timer);
      const { result, exceptionDetails } = message.result ?? {};
      try { ws.close(); } catch {}
      if (exceptionDetails) reject(new Error(exceptionDetails.exception?.description ?? exceptionDetails.text ?? "eval error"));
      else resolve(result?.value);
    };
    ws.onerror = () => { clearTimeout(timer); reject(new Error("Inspector WebSocket error")); };
  });
}
