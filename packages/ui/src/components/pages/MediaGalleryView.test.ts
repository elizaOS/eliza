import { describe, expect, it } from "vitest"
import { extractMediaFromRows } from "./MediaGalleryView"

describe("extractMediaFromRows", () => {
  it("extracts media URLs from object-valued jsonb content", () => {
    const items = extractMediaFromRows(
      [
        {
          createdAt: "2026-10-11T00:00:00.000Z",
          content: {
            attachments: [{ url: "https://cdn.example.com/photo.png" }],
          },
        },
      ],
      "memories",
    )

    expect(items.map((item) => item.url)).toEqual([
      "https://cdn.example.com/photo.png",
    ])
  })

  it("does not turn prose filenames into gallery items", () => {
    const items = extractMediaFromRows(
      [{ content: { text: "I saved logo.png for the header" } }],
      "memories",
    )

    expect(items).toEqual([])
  })

  it("keeps absolute media URLs in prose", () => {
    const items = extractMediaFromRows(
      [
        {
          content: {
            text: "Open https://cdn.example.com/photo.png when ready",
          },
        },
      ],
      "memories",
    )

    expect(items.map((item) => item.url)).toEqual([
      "https://cdn.example.com/photo.png",
    ])
  })
})