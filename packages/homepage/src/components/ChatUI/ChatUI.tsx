export default function ChatUI() {
  return (
    <div
      style={{
        width: 390,
        height: 844,
        background: "#000",
        borderRadius: 8,
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
        fontFamily: "-apple-system, BlinkMacSystemFont, sans-serif",
        color: "#fff",
      }}
    >
      {/* Status bar */}
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          padding: "8px 16px",
          fontSize: 11,
          fontWeight: 600,
        }}
      >
        <span>9:41</span>
        <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
          <span style={{ fontSize: 10 }}>5G</span>
          <div
            style={{
              width: 20,
              height: 10,
              border: "1px solid #fff",
              borderRadius: 2,
              padding: 1,
            }}
          >
            <div
              style={{
                width: "80%",
                height: "100%",
                background: "#34c759",
                borderRadius: 1,
              }}
            />
          </div>
        </div>
      </div>

      {/* Header */}
      <div
        style={{
          padding: "6px 16px 10px",
          borderBottom: "1px solid #1c1c1e",
          display: "flex",
          alignItems: "center",
          gap: 10,
        }}
      >
        <div
          style={{
            width: 32,
            height: 32,
            borderRadius: "50%",
            background: "linear-gradient(135deg, #6366f1, #8b5cf6)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: 14,
            fontWeight: 700,
          }}
        >
          E
        </div>
        <div>
          <div style={{ fontSize: 14, fontWeight: 600 }}>Eliza</div>
          <div style={{ fontSize: 10, color: "#86868b" }}>Online</div>
        </div>
      </div>

      {/* Messages */}
      <div
        style={{
          flex: 1,
          padding: "12px 12px",
          display: "flex",
          flexDirection: "column",
          gap: 8,
          overflowY: "auto",
        }}
      >
        <Bubble from="bot">Hey! How can I help you today? 👋</Bubble>
        <Bubble from="user">Can you help me build a landing page?</Bubble>
        <Bubble from="bot">
          Of course! I&apos;d love to help. What kind of style are you going for?
        </Bubble>
        <Bubble from="user">Something minimal and modern</Bubble>
        <Bubble from="bot">
          Great choice. Let me put together a clean layout with smooth
          animations. Give me a moment...
        </Bubble>
        <Bubble from="user">That sounds perfect, thanks!</Bubble>
      </div>

      {/* Input */}
      <div style={{ padding: "8px 12px 12px" }}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            background: "#1c1c1e",
            borderRadius: 20,
            padding: "8px 12px",
          }}
        >
          <div
            style={{
              flex: 1,
              fontSize: 13,
              color: "#86868b",
            }}
          >
            Message...
          </div>
          <div
            style={{
              width: 26,
              height: 26,
              borderRadius: "50%",
              background: "#6366f1",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: 13,
            }}
          >
            ↑
          </div>
        </div>
      </div>
    </div>
  );
}

function Bubble({
  from,
  children,
}: {
  from: "user" | "bot";
  children: React.ReactNode;
}) {
  const isUser = from === "user";
  return (
    <div
      style={{
        alignSelf: isUser ? "flex-end" : "flex-start",
        maxWidth: "80%",
        padding: "8px 12px",
        borderRadius: 16,
        borderBottomRightRadius: isUser ? 4 : 16,
        borderBottomLeftRadius: isUser ? 16 : 4,
        background: isUser ? "#6366f1" : "#1c1c1e",
        fontSize: 12,
        lineHeight: 1.4,
        color: "#fff",
      }}
    >
      {children}
    </div>
  );
}
