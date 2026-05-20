/**
 * Tests for NewsArticlePacingEngine
 */

import { beforeEach, describe, expect, it } from "bun:test";
import { NewsArticlePacingEngine } from "../NewsArticlePacingEngine";

describe("NewsArticlePacingEngine", () => {
  let pacer: NewsArticlePacingEngine;

  beforeEach(() => {
    pacer = new NewsArticlePacingEngine();
  });

  describe("Validation", () => {
    it("should throw on invalid questionId", () => {
      expect(() => {
        pacer.shouldGenerateArticle(0, "org-1", "breaking");
      }).toThrow("Invalid questionId");

      expect(() => {
        pacer.shouldGenerateArticle(-1, "org-1", "breaking");
      }).toThrow("Invalid questionId");
    });

    it("should throw on empty orgId", () => {
      expect(() => {
        pacer.shouldGenerateArticle(1, "", "breaking");
      }).toThrow("Invalid orgId");

      expect(() => {
        pacer.shouldGenerateArticle(1, "   ", "breaking");
      }).toThrow("Invalid orgId");
    });

    it("should throw on invalid stage", () => {
      expect(() => {
        pacer.shouldGenerateArticle(1, "org-1", "invalid" as never);
      }).toThrow("Invalid stage");
    });

    it("should throw when recording with invalid inputs", () => {
      expect(() => {
        pacer.recordArticle(0, "org-1", "breaking", "article-1", 100);
      }).toThrow("Invalid questionId");

      expect(() => {
        pacer.recordArticle(1, "", "breaking", "article-1", 100);
      }).toThrow("Invalid orgId");

      expect(() => {
        pacer.recordArticle(1, "org-1", "invalid" as never, "article-1", 100);
      }).toThrow("Invalid stage");

      expect(() => {
        pacer.recordArticle(1, "org-1", "breaking", "", 100);
      }).toThrow("Invalid articleId");

      expect(() => {
        pacer.recordArticle(1, "org-1", "breaking", "article-1", -1);
      }).toThrow("Invalid tick");
    });

    it("should throw when selecting orgs with empty array", () => {
      expect(() => {
        pacer.selectOrgsForStage([], 1, "breaking");
      }).toThrow("availableOrgs cannot be empty");
    });

    it("should throw when org missing id", () => {
      expect(() => {
        pacer.selectOrgsForStage([{ id: "", name: "CNN" }], 1, "breaking");
      }).toThrow("Organization missing id");
    });

    it("should throw when org missing name", () => {
      expect(() => {
        pacer.selectOrgsForStage([{ id: "cnn", name: "" }], 1, "breaking");
      }).toThrow("Organization missing name");
    });
  });

  describe("Breaking Stage", () => {
    it("should allow first 2 orgs to break story", () => {
      expect(pacer.shouldGenerateArticle(1, "org-1", "breaking")).toBe(true);
      pacer.recordArticle(1, "org-1", "breaking", "article-1", 10);

      expect(pacer.shouldGenerateArticle(1, "org-2", "breaking")).toBe(true);
      pacer.recordArticle(1, "org-2", "breaking", "article-2", 11);

      expect(pacer.shouldGenerateArticle(1, "org-3", "breaking")).toBe(false);
    });

    it("should prevent same org from breaking twice", () => {
      expect(pacer.shouldGenerateArticle(1, "org-1", "breaking")).toBe(true);
      pacer.recordArticle(1, "org-1", "breaking", "article-1", 10);

      expect(pacer.shouldGenerateArticle(1, "org-1", "breaking")).toBe(false);
    });

    it("should select 1-2 orgs for breaking", () => {
      const orgs = [
        { id: "org-1", name: "CNN" },
        { id: "org-2", name: "Fox" },
        { id: "org-3", name: "NYT" },
        { id: "org-4", name: "WSJ" },
      ];

      const selected = pacer.selectOrgsForStage(orgs, 1, "breaking");
      expect(selected.length).toBeGreaterThanOrEqual(1);
      expect(selected.length).toBeLessThanOrEqual(2);
    });
  });

  describe("Commentary Stage", () => {
    it("should allow up to 3 orgs for commentary", () => {
      expect(pacer.shouldGenerateArticle(1, "org-1", "commentary")).toBe(true);
      pacer.recordArticle(1, "org-1", "commentary", "article-1", 20);

      expect(pacer.shouldGenerateArticle(1, "org-2", "commentary")).toBe(true);
      pacer.recordArticle(1, "org-2", "commentary", "article-2", 21);

      expect(pacer.shouldGenerateArticle(1, "org-3", "commentary")).toBe(true);
      pacer.recordArticle(1, "org-3", "commentary", "article-3", 22);

      expect(pacer.shouldGenerateArticle(1, "org-4", "commentary")).toBe(false);
    });

    it("should select 2-3 orgs for commentary", () => {
      const orgs = [
        { id: "org-1", name: "CNN" },
        { id: "org-2", name: "Fox" },
        { id: "org-3", name: "NYT" },
        { id: "org-4", name: "WSJ" },
        { id: "org-5", name: "BBC" },
      ];

      const selected = pacer.selectOrgsForStage(orgs, 1, "commentary");
      expect(selected.length).toBeGreaterThanOrEqual(2);
      expect(selected.length).toBeLessThanOrEqual(3);
    });
  });

  describe("Resolution Stage", () => {
    it("should allow unlimited orgs for resolution", () => {
      for (let i = 1; i <= 10; i++) {
        expect(pacer.shouldGenerateArticle(1, `org-${i}`, "resolution")).toBe(
          true,
        );
        pacer.recordArticle(
          1,
          `org-${i}`,
          "resolution",
          `article-${i}`,
          30 + i,
        );
      }

      expect(pacer.shouldGenerateArticle(1, "org-11", "resolution")).toBe(true);
    });

    it("should prevent same org from resolving twice", () => {
      expect(pacer.shouldGenerateArticle(1, "org-1", "resolution")).toBe(true);
      pacer.recordArticle(1, "org-1", "resolution", "article-1", 30);

      expect(pacer.shouldGenerateArticle(1, "org-1", "resolution")).toBe(false);
    });

    it("should select up to 5 orgs for resolution", () => {
      const orgs = [
        { id: "org-1", name: "CNN" },
        { id: "org-2", name: "Fox" },
        { id: "org-3", name: "NYT" },
        { id: "org-4", name: "WSJ" },
        { id: "org-5", name: "BBC" },
        { id: "org-6", name: "Reuters" },
        { id: "org-7", name: "AP" },
      ];

      const selected = pacer.selectOrgsForStage(orgs, 1, "resolution");
      expect(selected.length).toBeLessThanOrEqual(5);
    });
  });

  describe("Multi-Question Isolation", () => {
    it("should track different questions separately", () => {
      expect(pacer.shouldGenerateArticle(1, "org-1", "breaking")).toBe(true);
      pacer.recordArticle(1, "org-1", "breaking", "article-1", 10);

      expect(pacer.shouldGenerateArticle(2, "org-1", "breaking")).toBe(true);
      pacer.recordArticle(2, "org-1", "breaking", "article-2", 11);

      expect(pacer.getArticlesForQuestion(1).length).toBe(1);
      expect(pacer.getArticlesForQuestion(2).length).toBe(1);
    });

    it("should allow same org for different stages of same question", () => {
      expect(pacer.shouldGenerateArticle(1, "org-1", "breaking")).toBe(true);
      pacer.recordArticle(1, "org-1", "breaking", "article-1", 10);

      expect(pacer.shouldGenerateArticle(1, "org-1", "commentary")).toBe(true);
      pacer.recordArticle(1, "org-1", "commentary", "article-2", 20);

      expect(pacer.shouldGenerateArticle(1, "org-1", "resolution")).toBe(true);
    });
  });

  describe("Statistics", () => {
    it("should track articles per question", () => {
      pacer.recordArticle(1, "org-1", "breaking", "article-1", 10);
      pacer.recordArticle(1, "org-2", "commentary", "article-2", 20);
      pacer.recordArticle(2, "org-1", "breaking", "article-3", 15);

      expect(pacer.getArticlesForQuestion(1).length).toBe(2);
      expect(pacer.getArticlesForQuestion(2).length).toBe(1);
    });

    it("should track stage statistics", () => {
      pacer.recordArticle(1, "org-1", "breaking", "article-1", 10);
      pacer.recordArticle(1, "org-2", "breaking", "article-2", 11);
      pacer.recordArticle(1, "org-3", "commentary", "article-3", 20);

      const stats = pacer.getStageStats(1);
      expect(stats.breaking).toBe(2);
      expect(stats.commentary).toBe(1);
      expect(stats.resolution).toBe(0);
    });

    it("should track total articles across all stages", () => {
      pacer.recordArticle(1, "org-1", "breaking", "article-1", 10);
      pacer.recordArticle(2, "org-2", "commentary", "article-2", 20);
      pacer.recordArticle(3, "org-3", "resolution", "article-3", 30);

      expect(pacer.getTotalArticles()).toBe(3);
    });

    it("should track articles by stage globally", () => {
      pacer.recordArticle(1, "org-1", "breaking", "article-1", 10);
      pacer.recordArticle(2, "org-2", "breaking", "article-2", 11);
      pacer.recordArticle(1, "org-3", "commentary", "article-3", 20);
      pacer.recordArticle(2, "org-4", "commentary", "article-4", 21);
      pacer.recordArticle(1, "org-5", "resolution", "article-5", 30);

      const counts = pacer.getArticleCountByStage();
      expect(counts.breaking).toBe(2);
      expect(counts.commentary).toBe(2);
      expect(counts.resolution).toBe(1);
    });
  });

  describe("Cleanup", () => {
    it("should clear question records", () => {
      pacer.recordArticle(1, "org-1", "breaking", "article-1", 10);
      pacer.recordArticle(1, "org-2", "commentary", "article-2", 20);
      pacer.recordArticle(2, "org-1", "breaking", "article-3", 15);

      pacer.clearQuestion(1);

      expect(pacer.getArticlesForQuestion(1).length).toBe(0);
      expect(pacer.getArticlesForQuestion(2).length).toBe(1);
    });

    it("should reset stage limits after clear", () => {
      pacer.recordArticle(1, "org-1", "breaking", "article-1", 10);
      pacer.recordArticle(1, "org-2", "breaking", "article-2", 11);

      expect(pacer.shouldGenerateArticle(1, "org-3", "breaking")).toBe(false);

      pacer.clearQuestion(1);

      expect(pacer.shouldGenerateArticle(1, "org-3", "breaking")).toBe(true);
    });
  });

  describe("Org Selection", () => {
    const orgs = [
      { id: "cnn", name: "CNN" },
      { id: "fox", name: "Fox News" },
      { id: "nyt", name: "New York Times" },
      { id: "wsj", name: "Wall Street Journal" },
      { id: "bbc", name: "BBC" },
    ];

    it("should return empty array if all orgs have published", () => {
      orgs.forEach((org) => {
        pacer.recordArticle(1, org.id, "breaking", `article-${org.id}`, 10);
      });

      const selected = pacer.selectOrgsForStage(orgs, 1, "breaking");
      expect(selected).toEqual([]);
    });

    it("should only select from eligible orgs", () => {
      pacer.recordArticle(1, "cnn", "breaking", "article-1", 10);
      pacer.recordArticle(1, "fox", "breaking", "article-2", 11);

      const selected = pacer.selectOrgsForStage(orgs, 1, "breaking");

      expect(
        selected.every((org) => org.id !== "cnn" && org.id !== "fox"),
      ).toBe(true);
    });

    it("should select different orgs each time (randomness)", () => {
      const selections = new Set<string>();

      for (let i = 1; i <= 10; i++) {
        const freshPacer = new NewsArticlePacingEngine();
        const selected = freshPacer.selectOrgsForStage(orgs, i, "breaking");
        selections.add(JSON.stringify(selected.map((o) => o.id).sort()));
      }

      expect(selections.size).toBeGreaterThanOrEqual(3);
    });
  });

  describe("Edge Cases", () => {
    it("should handle single org available", () => {
      const orgs = [{ id: "only-org", name: "Only News" }];

      const selected = pacer.selectOrgsForStage(orgs, 1, "breaking");
      expect(selected.length).toBe(1);
      expect(selected[0]?.id).toBe("only-org");
    });

    it("should handle more orgs than limit for breaking", () => {
      const orgs = Array.from({ length: 20 }, (_, i) => ({
        id: `org-${i}`,
        name: `Org ${i}`,
      }));

      const selected = pacer.selectOrgsForStage(orgs, 1, "breaking");
      expect(selected.length).toBeLessThanOrEqual(2);
    });

    it("should handle question ID collision for different stages", () => {
      pacer.recordArticle(1, "org-1", "breaking", "article-1", 10);
      pacer.recordArticle(1, "org-1", "commentary", "article-2", 20);
      pacer.recordArticle(1, "org-1", "resolution", "article-3", 30);

      const stats = pacer.getStageStats(1);
      expect(stats.breaking).toBe(1);
      expect(stats.commentary).toBe(1);
      expect(stats.resolution).toBe(1);
    });
  });

  describe("Arc Event Coverage", () => {
    describe("shouldGenerateArcEventArticle Validation", () => {
      it("should throw on invalid arcEventId", () => {
        expect(() => {
          pacer.shouldGenerateArcEventArticle("", "org-1", "created");
        }).toThrow("Invalid arcEventId");

        expect(() => {
          pacer.shouldGenerateArcEventArticle("   ", "org-1", "created");
        }).toThrow("Invalid arcEventId");
      });

      it("should throw on invalid orgId", () => {
        expect(() => {
          pacer.shouldGenerateArcEventArticle("arc-1", "", "created");
        }).toThrow("Invalid orgId");
      });

      it("should throw on invalid currentStatus", () => {
        expect(() => {
          pacer.shouldGenerateArcEventArticle(
            "arc-1",
            "org-1",
            "invalid" as never,
          );
        }).toThrow("Invalid currentStatus");
      });
    });

    describe("recordArcEventCoverage Validation", () => {
      it("should throw on invalid arcEventId", () => {
        expect(() => {
          pacer.recordArcEventCoverage("", "org-1", "created", "article-1");
        }).toThrow("Invalid arcEventId");
      });

      it("should throw on invalid orgId", () => {
        expect(() => {
          pacer.recordArcEventCoverage("arc-1", "", "created", "article-1");
        }).toThrow("Invalid orgId");
      });

      it("should throw on invalid status", () => {
        expect(() => {
          pacer.recordArcEventCoverage(
            "arc-1",
            "org-1",
            "invalid" as never,
            "article-1",
          );
        }).toThrow("Invalid status");
      });

      it("should throw on invalid articleId", () => {
        expect(() => {
          pacer.recordArcEventCoverage("arc-1", "org-1", "created", "");
        }).toThrow("Invalid articleId");
      });
    });

    describe("selectOrgsForArcEvent Validation", () => {
      const orgs = [
        { id: "org-1", name: "Org 1" },
        { id: "org-2", name: "Org 2" },
      ];

      it("should throw on invalid arcEventId", () => {
        expect(() => {
          pacer.selectOrgsForArcEvent("", "created", orgs);
        }).toThrow("Invalid arcEventId");
      });

      it("should throw on invalid currentStatus", () => {
        expect(() => {
          pacer.selectOrgsForArcEvent("arc-1", "invalid" as never, orgs);
        }).toThrow("Invalid currentStatus");
      });

      it("should throw on empty availableOrgs", () => {
        expect(() => {
          pacer.selectOrgsForArcEvent("arc-1", "created", []);
        }).toThrow("availableOrgs cannot be empty");
      });

      it("should throw on invalid maxOrgs", () => {
        expect(() => {
          pacer.selectOrgsForArcEvent("arc-1", "created", orgs, 0);
        }).toThrow("Invalid maxOrgs");
      });

      it("should throw on org missing id", () => {
        expect(() => {
          pacer.selectOrgsForArcEvent("arc-1", "created", [
            { id: "", name: "Test" },
          ]);
        }).toThrow("Organization missing id");
      });

      it("should throw on org missing name", () => {
        expect(() => {
          pacer.selectOrgsForArcEvent("arc-1", "created", [
            { id: "org-1", name: "" },
          ]);
        }).toThrow("Organization missing name");
      });
    });

    describe("Arc Event Coverage Flow", () => {
      const orgs = [
        { id: "cnn", name: "CNN" },
        { id: "fox", name: "Fox News" },
        { id: "bbc", name: "BBC" },
      ];

      it("should allow first coverage of an arc event", () => {
        expect(
          pacer.shouldGenerateArcEventArticle("arc-1", "org-1", "created"),
        ).toBe(true);
      });

      it("should prevent duplicate coverage at same status", () => {
        pacer.recordArcEventCoverage("arc-1", "org-1", "created", "article-1");

        expect(
          pacer.shouldGenerateArcEventArticle("arc-1", "org-1", "created"),
        ).toBe(false);
      });

      it("should allow coverage when status changes", () => {
        pacer.recordArcEventCoverage("arc-1", "org-1", "created", "article-1");

        expect(
          pacer.shouldGenerateArcEventArticle("arc-1", "org-1", "updated"),
        ).toBe(true);
      });

      it("should allow different orgs to cover same event", () => {
        pacer.recordArcEventCoverage("arc-1", "org-1", "created", "article-1");

        expect(
          pacer.shouldGenerateArcEventArticle("arc-1", "org-2", "created"),
        ).toBe(true);
      });

      it("should select orgs that have not covered the event", () => {
        pacer.recordArcEventCoverage("arc-1", "cnn", "created", "article-1");

        const selected = pacer.selectOrgsForArcEvent("arc-1", "created", orgs);

        expect(selected.every((org) => org.id !== "cnn")).toBe(true);
      });

      it("should respect maxOrgs limit", () => {
        const selected = pacer.selectOrgsForArcEvent(
          "arc-1",
          "created",
          orgs,
          1,
        );

        expect(selected.length).toBe(1);
      });

      it("should default maxOrgs to 2 when not specified", () => {
        // Create 5 orgs to verify the default limit of 2
        const manyOrgs = [
          { id: "org-1", name: "Org 1" },
          { id: "org-2", name: "Org 2" },
          { id: "org-3", name: "Org 3" },
          { id: "org-4", name: "Org 4" },
          { id: "org-5", name: "Org 5" },
        ];

        const selected = pacer.selectOrgsForArcEvent(
          "arc-default",
          "created",
          manyOrgs,
        );

        // Default maxOrgs is 2
        expect(selected.length).toBe(2);
      });

      it("should clear arc event coverage", () => {
        pacer.recordArcEventCoverage("arc-1", "org-1", "created", "article-1");
        expect(
          pacer.shouldGenerateArcEventArticle("arc-1", "org-1", "created"),
        ).toBe(false);

        pacer.clearArcEventCoverage("arc-1");

        expect(
          pacer.shouldGenerateArcEventArticle("arc-1", "org-1", "created"),
        ).toBe(true);
      });
    });
  });
});
