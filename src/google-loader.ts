let loading: Promise<void> | undefined;
const authListeners = new Set<() => void>();

/** Loads the Maps JS API once per page (every map instance is one billed map load). */
export function loadGoogleMaps(apiKey: string, downloadError = 'Could not download Google Maps.'): Promise<void> {
  const w = window as any;
  if (w.google?.maps?.importLibrary) return Promise.resolve();
  if (loading) return loading;

  w.gm_authFailure = () => authListeners.forEach((fn) => fn());
  loading = new Promise<void>((resolve, reject) => {
    const cb = '__enhancedMapCardMapsReady';
    w[cb] = () => {
      delete w[cb];
      resolve();
    };
    const params = new URLSearchParams({ key: apiKey, v: 'weekly', loading: 'async', callback: cb });
    const s = document.createElement('script');
    s.src = `https://maps.googleapis.com/maps/api/js?${params}`;
    s.async = true;
    s.onerror = () => {
      loading = undefined;
      s.remove();
      reject(new Error(downloadError));
    };
    document.head.appendChild(s);
  });
  return loading;
}

export function onGoogleAuthFailure(fn: () => void): () => void {
  authListeners.add(fn);
  return () => authListeners.delete(fn);
}

/**
 * Google injects the map CSS into <head>, which does not reach the card's shadow DOM.
 * Copy those styles into the shadow root and keep following new ones.
 */
export function mirrorGoogleStyles(root: ShadowRoot): () => void {
  const copied = new WeakSet<Node>();
  const copy = (node: Node) => {
    if (copied.has(node)) return;
    if (node instanceof HTMLLinkElement && node.rel === 'stylesheet' && /google|gstatic/.test(node.href)) {
      copied.add(node);
      root.appendChild(node.cloneNode());
    } else if (node instanceof HTMLStyleElement) {
      let text = node.textContent ?? '';
      if (!text) {
        try {
          text = Array.from(node.sheet?.cssRules ?? [], (r) => r.cssText).join('\n');
        } catch {
          return;
        }
      }
      if (!/\.gm-|gmp-|\.gm_|\.dismissButton/.test(text)) return;
      copied.add(node);
      const clone = document.createElement('style');
      clone.textContent = text;
      root.appendChild(clone);
    }
  };
  const sync = () => document.head.querySelectorAll('style, link[rel=stylesheet]').forEach(copy);
  sync();
  const obs = new MutationObserver(() => sync());
  obs.observe(document.head, { childList: true });
  return () => obs.disconnect();
}
