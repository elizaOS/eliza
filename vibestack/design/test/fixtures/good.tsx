const outside = { border: "1px solid var(--border)", title: "Order #1042", variant: "red" }
export const Good = () => (
  <div className="rounded-md bg-primary text-primary-foreground shadow-sm" style={outside}>
    {/* eslint-disable-next-line design-system/no-literal-colors -- chart series */}
    <svg fill="#4f46e5" />
    <a href="#feed">Order #1042</a>
    <p className="rounded-xl bg-card/50 font-mono shadow-lg hover:bg-accent!" style={{ color: "var(--primary)" }}>a</p>
  </div>
)
