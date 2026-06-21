import { useEffect, useState } from "react";
import { loadClaims, updateClaim, type StoredClaim } from "@/lib/claims-store";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
  );
}
