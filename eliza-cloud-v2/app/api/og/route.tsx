import { ImageResponse } from "next/og";
import { logger } from "@/lib/utils/logger";
import { NextRequest } from "next/server";

export const runtime = "edge";

// Brand colors matching the platform design system
const BRAND_ORANGE = "#FF5800";
const BRAND_BLUE = "#0B35F1";
const BRAND_BG = "#0A0A0A";
const BRAND_SURFACE = "#252527";
const BRAND_BORDER = "#E1E1E1";

// Brand gradient using actual platform colors
const BRAND_GRADIENT = `linear-gradient(135deg, ${BRAND_BG} 0%, ${BRAND_SURFACE} 100%)`;
const BRAND_ACCENT_GRADIENT = `linear-gradient(135deg, ${BRAND_ORANGE} 0%, #FF7A33 100%)`;

// System monospace font stack - works reliably in edge runtime
// Optimized for technical/code aesthetic matching platform
const MONO_FONT =
  "'SF Mono', 'Monaco', 'Inconsolata', 'Roboto Mono', 'Courier New', monospace";

/**
 * GET /api/og
 * Generates Open Graph images for various page types (character, chat, container).
 * Uses Next.js ImageResponse API to create dynamic OG images with brand styling.
 *
 * Query Parameters:
 * - `type`: "character" | "chat" | "container" | "default"
 * - `title`: Page title
 * - `description`: Page description
 * - `name`: Character or entity name
 * - `characterName`: Character name for chat/container types
 *
 * @param request - Request with query parameters for image customization.
 * @returns ImageResponse with generated OG image.
 */
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);

    const type = searchParams.get("type") || "default";
    const title = searchParams.get("title") || "elizaOS Platform";
    const description =
      searchParams.get("description") || "AI Agent Development Platform";
    const name = searchParams.get("name");
    const characterName = searchParams.get("characterName");

    switch (type) {
      case "character":
        return new ImageResponse(
          <div
            style={{
              height: "100%",
              width: "100%",
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              background: BRAND_BG,
              fontFamily: "system-ui, sans-serif",
              position: "relative",
            }}
          >
            {/* Corner Brackets */}
            <div
              style={{
                position: "absolute",
                left: 40,
                top: 40,
                width: 48,
                height: 48,
                borderTop: `3px solid ${BRAND_BORDER}`,
                borderLeft: `3px solid ${BRAND_BORDER}`,
              }}
            />
            <div
              style={{
                position: "absolute",
                right: 40,
                top: 40,
                width: 48,
                height: 48,
                borderTop: `3px solid ${BRAND_BORDER}`,
                borderRight: `3px solid ${BRAND_BORDER}`,
              }}
            />
            <div
              style={{
                position: "absolute",
                left: 40,
                bottom: 40,
                width: 48,
                height: 48,
                borderBottom: `3px solid ${BRAND_BORDER}`,
                borderLeft: `3px solid ${BRAND_BORDER}`,
              }}
            />
            <div
              style={{
                position: "absolute",
                right: 40,
                bottom: 40,
                width: 48,
                height: 48,
                borderBottom: `3px solid ${BRAND_BORDER}`,
                borderRight: `3px solid ${BRAND_BORDER}`,
              }}
            />

            <div
              style={{
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                justifyContent: "center",
                background: BRAND_SURFACE,
                border: `1px solid rgba(255, 255, 255, 0.1)`,
                padding: "60px 80px",
                maxWidth: "900px",
                position: "relative",
              }}
            >
              {/* Mini Corner Brackets on card */}
              <div
                style={{
                  position: "absolute",
                  left: 0,
                  top: 0,
                  width: 24,
                  height: 24,
                  borderTop: `2px solid ${BRAND_ORANGE}`,
                  borderLeft: `2px solid ${BRAND_ORANGE}`,
                }}
              />
              <div
                style={{
                  position: "absolute",
                  right: 0,
                  top: 0,
                  width: 24,
                  height: 24,
                  borderTop: `2px solid ${BRAND_ORANGE}`,
                  borderRight: `2px solid ${BRAND_ORANGE}`,
                }}
              />
              <div
                style={{
                  position: "absolute",
                  left: 0,
                  bottom: 0,
                  width: 24,
                  height: 24,
                  borderBottom: `2px solid ${BRAND_ORANGE}`,
                  borderLeft: `2px solid ${BRAND_ORANGE}`,
                }}
              />
              <div
                style={{
                  position: "absolute",
                  right: 0,
                  bottom: 0,
                  width: 24,
                  height: 24,
                  borderBottom: `2px solid ${BRAND_ORANGE}`,
                  borderRight: `2px solid ${BRAND_ORANGE}`,
                }}
              />

              <div
                style={{
                  display: "flex",
                  fontSize: 64,
                  fontWeight: 700,
                  color: "white",
                  marginBottom: 24,
                  textAlign: "center",
                  lineHeight: 1.2,
                  fontFamily: MONO_FONT,
                }}
              >
                {name || title}
              </div>
              <div
                style={{
                  display: "flex",
                  fontSize: 24,
                  color: "rgba(255, 255, 255, 0.7)",
                  textAlign: "center",
                  marginBottom: 32,
                  lineHeight: 1.5,
                  maxWidth: "700px",
                  fontFamily: MONO_FONT,
                }}
              >
                {description.slice(0, 120)}
                {description.length > 120 ? "..." : ""}
              </div>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  fontSize: 18,
                  color: BRAND_ORANGE,
                  fontWeight: 600,
                  fontFamily: MONO_FONT,
                }}
              >
                <div
                  style={{
                    width: 6,
                    height: 6,
                    background: BRAND_ORANGE,
                    borderRadius: "50%",
                  }}
                />
                elizaOS AI Character
              </div>
            </div>
          </div>,
          {
            width: 1200,
            height: 630,
          },
        );

      case "chat":
        return new ImageResponse(
          <div
            style={{
              height: "100%",
              width: "100%",
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              background: BRAND_BG,
              fontFamily: "system-ui, sans-serif",
              position: "relative",
            }}
          >
            {/* Corner Brackets */}
            <div
              style={{
                position: "absolute",
                left: 40,
                top: 40,
                width: 48,
                height: 48,
                borderTop: `3px solid ${BRAND_BORDER}`,
                borderLeft: `3px solid ${BRAND_BORDER}`,
              }}
            />
            <div
              style={{
                position: "absolute",
                right: 40,
                top: 40,
                width: 48,
                height: 48,
                borderTop: `3px solid ${BRAND_BORDER}`,
                borderRight: `3px solid ${BRAND_BORDER}`,
              }}
            />
            <div
              style={{
                position: "absolute",
                left: 40,
                bottom: 40,
                width: 48,
                height: 48,
                borderBottom: `3px solid ${BRAND_BORDER}`,
                borderLeft: `3px solid ${BRAND_BORDER}`,
              }}
            />
            <div
              style={{
                position: "absolute",
                right: 40,
                bottom: 40,
                width: 48,
                height: 48,
                borderBottom: `3px solid ${BRAND_BORDER}`,
                borderRight: `3px solid ${BRAND_BORDER}`,
              }}
            />

            <div
              style={{
                display: "flex",
                flexDirection: "column",
                alignItems: "flex-start",
                justifyContent: "center",
                background: BRAND_SURFACE,
                border: `1px solid rgba(255, 255, 255, 0.1)`,
                padding: "60px 80px",
                maxWidth: "900px",
                position: "relative",
              }}
            >
              {/* Mini Corner Brackets on card */}
              <div
                style={{
                  position: "absolute",
                  left: 0,
                  top: 0,
                  width: 24,
                  height: 24,
                  borderTop: `2px solid ${BRAND_ORANGE}`,
                  borderLeft: `2px solid ${BRAND_ORANGE}`,
                }}
              />
              <div
                style={{
                  position: "absolute",
                  right: 0,
                  top: 0,
                  width: 24,
                  height: 24,
                  borderTop: `2px solid ${BRAND_ORANGE}`,
                  borderRight: `2px solid ${BRAND_ORANGE}`,
                }}
              />
              <div
                style={{
                  position: "absolute",
                  left: 0,
                  bottom: 0,
                  width: 24,
                  height: 24,
                  borderBottom: `2px solid ${BRAND_ORANGE}`,
                  borderLeft: `2px solid ${BRAND_ORANGE}`,
                }}
              />
              <div
                style={{
                  position: "absolute",
                  right: 0,
                  bottom: 0,
                  width: 24,
                  height: 24,
                  borderBottom: `2px solid ${BRAND_ORANGE}`,
                  borderRight: `2px solid ${BRAND_ORANGE}`,
                }}
              />

              <div
                style={{
                  display: "flex",
                  fontSize: 36,
                  fontWeight: 600,
                  color: BRAND_ORANGE,
                  marginBottom: 24,
                  fontFamily: MONO_FONT,
                }}
              >
                💬 Chat Conversation
              </div>
              <div
                style={{
                  display: "flex",
                  fontSize: 58,
                  fontWeight: 700,
                  color: "white",
                  marginBottom: 24,
                  lineHeight: 1.2,
                  fontFamily: MONO_FONT,
                }}
              >
                {characterName || name || "AI Agent"}
              </div>
              <div
                style={{
                  display: "flex",
                  fontSize: 24,
                  color: "rgba(255, 255, 255, 0.6)",
                  marginBottom: 32,
                  fontFamily: MONO_FONT,
                }}
              >
                Join the conversation on elizaOS
              </div>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  fontSize: 18,
                  color: "rgba(255, 255, 255, 0.5)",
                  fontFamily: MONO_FONT,
                }}
              >
                <div
                  style={{
                    width: 6,
                    height: 6,
                    background: BRAND_ORANGE,
                    borderRadius: "50%",
                  }}
                />
                Powered by elizaOS
              </div>
            </div>
          </div>,
          {
            width: 1200,
            height: 630,
          },
        );

      case "container":
        return new ImageResponse(
          <div
            style={{
              height: "100%",
              width: "100%",
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              background: BRAND_BG,
              fontFamily: "system-ui, sans-serif",
              position: "relative",
            }}
          >
            {/* Corner Brackets */}
            <div
              style={{
                position: "absolute",
                left: 40,
                top: 40,
                width: 48,
                height: 48,
                borderTop: `3px solid ${BRAND_BORDER}`,
                borderLeft: `3px solid ${BRAND_BORDER}`,
              }}
            />
            <div
              style={{
                position: "absolute",
                right: 40,
                top: 40,
                width: 48,
                height: 48,
                borderTop: `3px solid ${BRAND_BORDER}`,
                borderRight: `3px solid ${BRAND_BORDER}`,
              }}
            />
            <div
              style={{
                position: "absolute",
                left: 40,
                bottom: 40,
                width: 48,
                height: 48,
                borderBottom: `3px solid ${BRAND_BORDER}`,
                borderLeft: `3px solid ${BRAND_BORDER}`,
              }}
            />
            <div
              style={{
                position: "absolute",
                right: 40,
                bottom: 40,
                width: 48,
                height: 48,
                borderBottom: `3px solid ${BRAND_BORDER}`,
                borderRight: `3px solid ${BRAND_BORDER}`,
              }}
            />

            <div
              style={{
                display: "flex",
                flexDirection: "column",
                alignItems: "flex-start",
                justifyContent: "center",
                background: BRAND_SURFACE,
                border: `1px solid rgba(255, 255, 255, 0.1)`,
                padding: "60px 80px",
                maxWidth: "900px",
                position: "relative",
              }}
            >
              {/* Mini Corner Brackets on card */}
              <div
                style={{
                  position: "absolute",
                  left: 0,
                  top: 0,
                  width: 24,
                  height: 24,
                  borderTop: `2px solid ${BRAND_ORANGE}`,
                  borderLeft: `2px solid ${BRAND_ORANGE}`,
                }}
              />
              <div
                style={{
                  position: "absolute",
                  right: 0,
                  top: 0,
                  width: 24,
                  height: 24,
                  borderTop: `2px solid ${BRAND_ORANGE}`,
                  borderRight: `2px solid ${BRAND_ORANGE}`,
                }}
              />
              <div
                style={{
                  position: "absolute",
                  left: 0,
                  bottom: 0,
                  width: 24,
                  height: 24,
                  borderBottom: `2px solid ${BRAND_ORANGE}`,
                  borderLeft: `2px solid ${BRAND_ORANGE}`,
                }}
              />
              <div
                style={{
                  position: "absolute",
                  right: 0,
                  bottom: 0,
                  width: 24,
                  height: 24,
                  borderBottom: `2px solid ${BRAND_ORANGE}`,
                  borderRight: `2px solid ${BRAND_ORANGE}`,
                }}
              />

              <div
                style={{
                  display: "flex",
                  fontSize: 36,
                  fontWeight: 600,
                  color: BRAND_ORANGE,
                  marginBottom: 24,
                  fontFamily: MONO_FONT,
                }}
              >
                🐳 Container Deployment
              </div>
              <div
                style={{
                  display: "flex",
                  fontSize: 58,
                  fontWeight: 700,
                  color: "white",
                  marginBottom: 24,
                  lineHeight: 1.2,
                  fontFamily: MONO_FONT,
                }}
              >
                {name || title}
              </div>
              {characterName && (
                <div
                  style={{
                    display: "flex",
                    fontSize: 28,
                    color: "rgba(255, 255, 255, 0.7)",
                    marginBottom: 32,
                    fontFamily: MONO_FONT,
                  }}
                >
                  Running: {characterName}
                </div>
              )}
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  fontSize: 18,
                  color: "rgba(255, 255, 255, 0.5)",
                  fontFamily: MONO_FONT,
                }}
              >
                <div
                  style={{
                    width: 6,
                    height: 6,
                    background: BRAND_ORANGE,
                    borderRadius: "50%",
                  }}
                />
                Deployed on elizaOS
              </div>
            </div>
          </div>,
          {
            width: 1200,
            height: 630,
          },
        );

      default:
        return new ImageResponse(
          <div
            style={{
              height: "100%",
              width: "100%",
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              background: BRAND_BG,
              fontFamily: "system-ui, sans-serif",
              position: "relative",
            }}
          >
            {/* Outer Corner Brackets */}
            <div
              style={{
                position: "absolute",
                left: 40,
                top: 40,
                width: 48,
                height: 48,
                borderTop: `3px solid ${BRAND_BORDER}`,
                borderLeft: `3px solid ${BRAND_BORDER}`,
              }}
            />
            <div
              style={{
                position: "absolute",
                right: 40,
                top: 40,
                width: 48,
                height: 48,
                borderTop: `3px solid ${BRAND_BORDER}`,
                borderRight: `3px solid ${BRAND_BORDER}`,
              }}
            />
            <div
              style={{
                position: "absolute",
                left: 40,
                bottom: 40,
                width: 48,
                height: 48,
                borderBottom: `3px solid ${BRAND_BORDER}`,
                borderLeft: `3px solid ${BRAND_BORDER}`,
              }}
            />
            <div
              style={{
                position: "absolute",
                right: 40,
                bottom: 40,
                width: 48,
                height: 48,
                borderBottom: `3px solid ${BRAND_BORDER}`,
                borderRight: `3px solid ${BRAND_BORDER}`,
              }}
            />

            <div
              style={{
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                justifyContent: "center",
                background: BRAND_SURFACE,
                border: `1px solid rgba(255, 255, 255, 0.1)`,
                padding: "60px 80px",
                maxWidth: "900px",
                position: "relative",
              }}
            >
              {/* Inner Orange Corner Brackets */}
              <div
                style={{
                  position: "absolute",
                  left: 0,
                  top: 0,
                  width: 24,
                  height: 24,
                  borderTop: `2px solid ${BRAND_ORANGE}`,
                  borderLeft: `2px solid ${BRAND_ORANGE}`,
                }}
              />
              <div
                style={{
                  position: "absolute",
                  right: 0,
                  top: 0,
                  width: 24,
                  height: 24,
                  borderTop: `2px solid ${BRAND_ORANGE}`,
                  borderRight: `2px solid ${BRAND_ORANGE}`,
                }}
              />
              <div
                style={{
                  position: "absolute",
                  left: 0,
                  bottom: 0,
                  width: 24,
                  height: 24,
                  borderBottom: `2px solid ${BRAND_ORANGE}`,
                  borderLeft: `2px solid ${BRAND_ORANGE}`,
                }}
              />
              <div
                style={{
                  position: "absolute",
                  right: 0,
                  bottom: 0,
                  width: 24,
                  height: 24,
                  borderBottom: `2px solid ${BRAND_ORANGE}`,
                  borderRight: `2px solid ${BRAND_ORANGE}`,
                }}
              />

              {/* Orange dot indicator */}
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  fontSize: 14,
                  color: "rgba(255, 255, 255, 0.5)",
                  marginBottom: 32,
                  textTransform: "uppercase",
                  letterSpacing: "0.15em",
                  fontFamily: MONO_FONT,
                }}
              >
                <div
                  style={{
                    width: 8,
                    height: 8,
                    background: BRAND_ORANGE,
                    borderRadius: "50%",
                  }}
                />
                elizaOS
              </div>

              <div
                style={{
                  display: "flex",
                  fontSize: 52,
                  fontWeight: 700,
                  color: "white",
                  marginBottom: 20,
                  textAlign: "center",
                  lineHeight: 1.2,
                  fontFamily: MONO_FONT,
                }}
              >
                {title}
              </div>
              <div
                style={{
                  display: "flex",
                  fontSize: 24,
                  color: "rgba(255, 255, 255, 0.7)",
                  textAlign: "center",
                  maxWidth: "700px",
                  lineHeight: 1.5,
                  fontFamily: MONO_FONT,
                  fontWeight: 400,
                }}
              >
                {description.slice(0, 100)}
                {description.length > 100 ? "..." : ""}
              </div>
            </div>
          </div>,
          {
            width: 1200,
            height: 630,
          },
        );
    }
  } catch (error) {
    logger.error("Error generating OG image:", error);

    return new ImageResponse(
      <div
        style={{
          height: "100%",
          width: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: BRAND_BG,
          fontFamily: "system-ui, sans-serif",
          position: "relative",
        }}
      >
        {/* Corner Brackets */}
        <div
          style={{
            position: "absolute",
            left: 40,
            top: 40,
            width: 48,
            height: 48,
            borderTop: `3px solid ${BRAND_BORDER}`,
            borderLeft: `3px solid ${BRAND_BORDER}`,
          }}
        />
        <div
          style={{
            position: "absolute",
            right: 40,
            top: 40,
            width: 48,
            height: 48,
            borderTop: `3px solid ${BRAND_BORDER}`,
            borderRight: `3px solid ${BRAND_BORDER}`,
          }}
        />
        <div
          style={{
            position: "absolute",
            left: 40,
            bottom: 40,
            width: 48,
            height: 48,
            borderBottom: `3px solid ${BRAND_BORDER}`,
            borderLeft: `3px solid ${BRAND_BORDER}`,
          }}
        />
        <div
          style={{
            position: "absolute",
            right: 40,
            bottom: 40,
            width: 48,
            height: 48,
            borderBottom: `3px solid ${BRAND_BORDER}`,
            borderRight: `3px solid ${BRAND_BORDER}`,
          }}
        />

        <div
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: 20,
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 12,
            }}
          >
            <div
              style={{
                width: 12,
                height: 12,
                background: BRAND_ORANGE,
                borderRadius: "50%",
              }}
            />
            <div
              style={{
                display: "flex",
                fontSize: 64,
                fontWeight: 700,
                color: "white",
                fontFamily: MONO_FONT,
              }}
            >
              elizaOS
            </div>
          </div>
          <div
            style={{
              display: "flex",
              width: 100,
              height: 3,
              background: BRAND_ORANGE,
            }}
          />
        </div>
      </div>,
      {
        width: 1200,
        height: 630,
      },
    );
  }
}
