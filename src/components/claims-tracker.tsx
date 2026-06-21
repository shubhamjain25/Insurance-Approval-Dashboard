import { useEffect, useState } from "react";
import { loadClaims, updateClaim, type StoredClaim } from "@/lib/claims-store";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Eye } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

const STATUS_STYLES: Record<string, string> = {
  APPROVED: "bg-primary/15 text-primary border-primary/30",
  REJECTED: "bg-destructive/10 text-destructive border-destructive/30",
  FAILED: "bg-destructive/10 text-destructive border-destructive/30",
  PENDING_REVIEW: "bg-amber-500/15 text-amber-700 dark:text-amber-400 border-amber-500/30",
  UNDER_REVIEW: "bg-amber-500/15 text-amber-700 dark:text-amber-400 border-amber-500/30",
  CANCELLED: "bg-muted text-muted-foreground border-border",
};

export function ClaimsTracker({ refreshKey }: { refreshKey: number }) {
  const [claims, setClaims] = useState<StoredClaim[]>([]);
  const [logClaim, setLogClaim] = useState<StoredClaim | null>(null);

  useEffect(() => {
    setClaims(loadClaims());
  }, [refreshKey]);

  function cancel(id: string) {
    updateClaim(id, { status: "CANCELLED", reason: "Cancelled by employee" });
    setClaims(loadClaims());
  }

  if (claims.length === 0) {
    return (
      <div className="rounded-2xl border border-dashed border-border p-8 text-center">
        <p className="text-sm text-muted-foreground">
          No claims submitted yet. Your filed claims will appear here.
        </p>
      </div>
    );
  }

  return (
    <>
      <ul className="space-y-3">
        {claims.map((c) => (
          <li
            key={c.id}
            className="rounded-xl border border-border bg-card p-4 transition-colors hover:border-foreground/20"
          >
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="font-mono text-xs text-muted-foreground">{c.id}</span>
                  <Badge variant="outline" className={cn("border", STATUS_STYLES[c.status])}>
                    {c.status.replace("_", "-")}
                  </Badge>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-6 gap-1 px-1.5 text-[11px] text-muted-foreground"
                    onClick={() => setLogClaim(c)}
                  >
                    <Eye className="h-3 w-3" /> Log ({c.log?.length ?? 0})
                  </Button>
                </div>
                <div className="mt-1 text-sm font-medium text-foreground">
                  {c.claimant_name} · {c.category} · ₹{c.amount.toLocaleString("en-IN")}
                </div>
                <div className="text-xs text-muted-foreground">
                  Treated {c.treatment_date} at {c.hospital} · Filed {new Date(c.submitted_at).toLocaleString()}
                </div>
                <div className="mt-1 text-xs text-muted-foreground">{c.reason}</div>
              </div>
              <div className="text-right">
                <div className="text-xs text-muted-foreground">Payable</div>
                <div className="text-lg font-semibold text-foreground">
                  ₹{c.approved_amount.toLocaleString("en-IN")}
                </div>
                {(c.status === "PENDING_REVIEW" || c.status === "APPROVED" || c.status === "UNDER_REVIEW") && (
                  <Button size="sm" variant="ghost" className="mt-1 h-7 text-xs" onClick={() => cancel(c.id)}>
                    Cancel
                  </Button>
                )}
              </div>
            </div>
          </li>
        ))}
      </ul>

      <Dialog open={!!logClaim} onOpenChange={(open) => !open && setLogClaim(null)}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Eye className="h-4 w-4" /> Claim activity log
            </DialogTitle>
            <DialogDescription>
              {logClaim?.id} · Ticket {logClaim?.ticket ?? "—"} — every state transition and the full verification
              response for each document.
            </DialogDescription>
          </DialogHeader>
          <div className="max-h-[60vh] space-y-2 overflow-y-auto">
            {(!logClaim?.log || logClaim.log.length === 0) && (
              <p className="text-sm text-muted-foreground">No log recorded for this claim.</p>
            )}
            {logClaim?.log?.map((entry, i) => (
              <div key={i} className="rounded-md bg-muted/40 p-2.5 text-xs">
                <div className="flex items-center gap-2 text-muted-foreground">
                  <span className="font-mono">{new Date(entry.at).toLocaleTimeString()}</span>
                  <Badge variant="outline" className="text-[10px]">
                    {entry.stage}
                  </Badge>
                </div>
                <div className="mt-0.5 text-foreground">{entry.event}</div>
                {entry.detail && (
                  <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded bg-background/60 p-2 text-[10px] text-muted-foreground">
                    {JSON.stringify(entry.detail, null, 2)}
                  </pre>
                )}
              </div>
            ))}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}