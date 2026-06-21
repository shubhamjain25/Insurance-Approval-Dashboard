type CustomErrorOptions = {
  mechanism?: "manual" | "onerror" | "unhandledrejection" | "react_error_boundary";
  handled?: boolean;
  severity?: "error" | "warning" | "info";
};

type CustomEvents = {
  captureException?: (
    error: unknown,
    context?: Record<string, unknown>,
    options?: CustomErrorOptions,
  ) => void;
};

declare global {
  interface Window {
    __customEvents?: CustomEvents;
  }
}

export function reportCustomError(error: unknown, context: Record<string, unknown> = {}) {
  if (typeof window === "undefined") return;
  window.__customEvents?.captureException?.(
    error,
    {
      source: "react_error_boundary",
      route: window.location.pathname,
      ...context,
    },
    {
      mechanism: "react_error_boundary",
      handled: false,
      severity: "error",
    },
  );
}
