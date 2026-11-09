// Minimal Chrome DevTools Protocol client for the eXpress desktop app's Node inspector.
// The inspector (opened with SIGUSR1) exposes the MAIN process. We evaluate an
// expression there that drives the renderer via webContents.executeJavaScript.

const INSPECTOR_LIST = "http://127.0.0.1:9229/json/list";
const EVAL_TIMEOUT_MS = 25_000;

interface InspectorTarget {
  webSocketDebuggerUrl?: string;
}

interface EvaluateResponse {
  id?: number;
  result?: {
    result?: { value?: unknown };
    exceptionDetails?: { exception?: { description?: string }; text?: string };
  };
}

export async function portOpen(): Promise<boolean> {
  try {
    const res = await fetch(INSPECTOR_LIST, { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch {
    return false;
  }
}

// Run `code` (a string of renderer-side JS) inside the eXpress window and return its value.
export async function evalRenderer<T = unknown>(code: string): Promise<T> {
  const list = (await (await fetch(INSPECTOR_LIST)).json()) as InspectorTarget[];
  const target = list.find((t) => typeof t.webSocketDebuggerUrl === "string");
  if (!target?.webSocketDebuggerUrl) throw new Error("No inspector target (is the debug port open?)");

  const expression = `require('electron').webContents.fromId(1).executeJavaScript(${JSON.stringify(code)})`;
  const ws = new WebSocket(target.webSocketDebuggerUrl);

  return await new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      try { ws.close(); } catch { /* ignore */ }
      reject(new Error("Inspector eval timed out"));
    }, EVAL_TIMEOUT_MS);

    ws.onopen = (): void => {
      ws.send(JSON.stringify({
        id: 1,
        method: "Runtime.evaluate",
        params: { expression, includeCommandLineAPI: true, awaitPromise: true, returnByValue: true },
      }));
    };

    ws.onmessage = (event): void => {
      const message = JSON.parse(String(event.data)) as EvaluateResponse;
      if (message.id !== 1) return;
      clearTimeout(timer);
      const inner = message.result ?? {};
      try { ws.close(); } catch { /* ignore */ }
      if (inner.exceptionDetails) {
        reject(new Error(inner.exceptionDetails.exception?.description ?? inner.exceptionDetails.text ?? "eval error"));
      } else {
        resolve(inner.result?.value as T);
      }
    };

    ws.onerror = (): void => {
      clearTimeout(timer);
      reject(new Error("Inspector WebSocket error"));
    };
  });
}
