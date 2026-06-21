import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { Toaster } from "@/components/ui/sonner";
import { ClaimWizard } from "@/components/claim-wizard";
import { ClaimsTracker } from "@/components/claims-tracker";
import { policy } from "@/lib/policy";
import { ShieldCheck, PlusCircle } from "lucide-react";
import { Button } from "@/components/ui/button";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Plum Health — File a Claim" },
      {
        name: "description",
        content:
          "Guided employee dashboard to submit, validate and track group health insurance claims.",
      },
    ],
  }),
  component: Index,
});

function generateTicket(): string {
  // 10-char alphanumeric ticket derived from crypto-random bytes; used for logging.
  const src =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID().replace(/-/g, "")
      : Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
  return src.replace(/[^a-zA-Z0-9]/g, "").slice(0, 10).toUpperCase();
}

function Index() {
  const [refreshKey, setRefreshKey] = useState(0);
  const [ticket, setTicket] = useState<string | null>(null);

  function initiate() {
    setTicket(generateTicket());
  }

  function handleSubmitted() {
    setRefreshKey((k) => k + 1);
    setTicket(null);
  }

  return (
    <div className="min-h-screen bg-background">
      <Toaster richColors position="top-right" />

      <header className="border-b border-border bg-card/50 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
          <div className="flex items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary text-primary-foreground">
              <ShieldCheck className="h-5 w-5" />
            </div>
            <div>
              <div className="text-sm font-semibold text-foreground">Insurance Health Inc.</div>
              <div className="text-xs text-muted-foreground">
                {policy.policy_holder.company_name} · {policy.policy_name}
              </div>
            </div>
          </div>
          <div className="hidden sm:flex items-center gap-6 text-right">
            <Stat label="Sum insured" value={`₹${policy.coverage.sum_insured_per_employee.toLocaleString("en-IN")}`} />
            <Stat label="Annual OPD" value={`₹${policy.coverage.annual_opd_limit.toLocaleString("en-IN")}`} />
            <Stat label="Per-claim cap" value={`₹${policy.coverage.per_claim_limit.toLocaleString("en-IN")}`} />
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-6 py-10">
        <div className="mb-10 flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="text-3xl font-semibold tracking-tight text-foreground">File a new claim</h1>
            <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
              Initiate a claim to receive a unique ticket ID, then complete each guided stage. Try member IDs{" "}
              <span className="font-mono text-foreground">EMP001</span> –{" "}
              <span className="font-mono text-foreground">EMP010</span>.
            </p>
          </div>
          {!ticket && (
            <Button size="lg" onClick={initiate} className="shrink-0">
              <PlusCircle className="mr-2 h-5 w-5" /> Initiate a claim
            </Button>
          )}
        </div>

        {ticket ? (
          <ClaimWizard ticket={ticket} onSubmitted={handleSubmitted} />
        ) : (
          <div className="rounded-2xl border border-dashed border-border bg-card/40 px-6 py-16 text-center">
            <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-primary/10 text-primary">
              <PlusCircle className="h-6 w-6" />
            </div>
            <h2 className="mt-4 text-lg font-semibold text-foreground">No active claim</h2>
            <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">
              Press <span className="font-medium text-foreground">Initiate a claim</span> to generate a ticket ID
              and start the guided submission workflow.
            </p>
            <Button className="mt-5" onClick={initiate}>
              <PlusCircle className="mr-2 h-4 w-4" /> Initiate a claim
            </Button>
          </div>
        )}

        <div className="mt-16">
          <div className="mb-4 flex items-baseline justify-between">
            <h2 className="text-xl font-semibold tracking-tight text-foreground">My claims</h2>
            <span className="text-xs text-muted-foreground">Auto-saved locally</span>
          </div>
          <ClaimsTracker refreshKey={refreshKey} />
        </div>
      </main>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="text-sm font-semibold text-foreground">{value}</div>
    </div>
  );
}
