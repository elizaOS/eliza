import type { V5MessageHandlerOutput } from "./message-handler.ts";
import { describe, expect, it } from "vitest";
import {
  looksLikeExplicitMediaGenerationRequest as actionLooksLikeExplicitMediaRequest,
} from "../features/advanced-capabilities/actions/generateMedia.ts";
import {
  looksLikeExplicitMediaGenerationRequest,
  routeMessageHandlerOutput,
} from "./message-handler.ts";

describe("explicit media request detector (issue #37021)", () => {
  describe("detects explicit media generation requests with regeneration verbs", () => {
    const positiveCases = [
      "can you try to remake the image without the watermark",
      "can you try to remake the image without it",
      "remake this picture in high resolution",
      "can you redo that drawing?",
      "redo the illustration",
      "regenerate the photo in watercolor style",
      "recreate the logo with sharper edges",
      "generate a picture of a lighthouse",
      "make an image of a sunset over the ocean",
      "create an illustration of a cozy cabin",
      "paint a portrait of a warrior",
    ];

    it.each(positiveCases)("message-handler detector accepts: %s", (text) => {
      expect(looksLikeExplicitMediaGenerationRequest(text)).toBe(true);
    });

    it.each(positiveCases)("generateMedia action detector accepts: %s", (text) => {
      expect(actionLooksLikeExplicitMediaRequest(text)).toBe(true);
    });
  });

  describe("detects requests explicitly naming the generator tool", () => {
    const generatorInvocationCases = [
      "can you try urself with image gen?",
      "can you try yourself with image gen?",
      "try with image gen",
      "try using image gen",
      "use image gen",
      "use image gen to show me",
      "use video gen to make a clip",
      "do it with image gen",
      "run image gen please",
    ];

    it.each(generatorInvocationCases)("message-handler detector accepts: %s", (text) => {
      expect(looksLikeExplicitMediaGenerationRequest(text)).toBe(true);
    });

    it.each(generatorInvocationCases)("generateMedia action detector accepts: %s", (text) => {
      expect(actionLooksLikeExplicitMediaRequest(text)).toBe(true);
    });
  });

  describe("rejects technical and infrastructure references to images", () => {
    const technicalCases = [
      "regenerate the docker image tag",
      "regenerate the container image",
      "build the docker image for production",
      "pull the image digest from the registry",
      "inspect the container image layer",
      "push the docker image to ghcr.io",
      "create a disk image for backup",
      "regenerate the vm image",
    ];

    it.each(technicalCases)("message-handler detector rejects: %s", (text) => {
      expect(looksLikeExplicitMediaGenerationRequest(text)).toBe(false);
    });

    it.each(technicalCases)("generateMedia action detector rejects: %s", (text) => {
      expect(actionLooksLikeExplicitMediaRequest(text)).toBe(false);
    });
  });

  describe("rejects capability inquiries about the generator", () => {
    const inquiryCases = [
      "do you have image gen?",
      "do you have an image generator?",
      "do you have image generation?",
      "is there image gen?",
      "is image gen available here?",
      "is image gen hooked up?",
      "do you support image generation?",
      "have you got image gen?",
      "what image gen do you have?",
      "do you use image gen?",
      "do you know about image gen?",
      "can you use image gen?",
    ];

    it.each(inquiryCases)("message-handler detector rejects: %s", (text) => {
      expect(looksLikeExplicitMediaGenerationRequest(text)).toBe(false);
    });

    it.each(inquiryCases)("generateMedia action detector rejects: %s", (text) => {
      expect(actionLooksLikeExplicitMediaRequest(text)).toBe(false);
    });
  });

  describe("rejects prohibitions and negations against generator use", () => {
    const prohibitionCases = [
      "no image gen please",
      "please don't use image gen",
      "stop using image gen",
      "never use image gen",
      "don't generate images",
      "do not create pictures",
    ];

    it.each(prohibitionCases)("message-handler detector rejects: %s", (text) => {
      expect(looksLikeExplicitMediaGenerationRequest(text)).toBe(false);
    });

    it.each(prohibitionCases)("generateMedia action detector rejects: %s", (text) => {
      expect(actionLooksLikeExplicitMediaRequest(text)).toBe(false);
    });
  });

  describe("rejects incidental non-media mentions", () => {
    const incidentalCases = [
      "send me the image you saved earlier",
      "make a plan for tomorrow",
      "generate a status report",
      "create a todo list",
    ];

    it.each(incidentalCases)("message-handler detector rejects: %s", (text) => {
      expect(looksLikeExplicitMediaGenerationRequest(text)).toBe(false);
    });

    it.each(incidentalCases)("generateMedia action detector rejects: %s", (text) => {
      expect(actionLooksLikeExplicitMediaRequest(text)).toBe(false);
    });
  });

  describe("end-to-end routing behavior in routeMessageHandlerOutput", () => {
    it("promotes simple capability denial to planning and seeds GENERATE_MEDIA for remake request", () => {
      const output: V5MessageHandlerOutput = {
        shouldRespond: true,
        plan: {
          reply: "i don't have image gen hooked up here. i can read and describe them, not make them.",
          contexts: ["simple"],
          requiresTool: false,
          candidateActions: [],
        },
      };

      const route = routeMessageHandlerOutput(output, {
        messageText: "can you try to remake the image without the watermark",
      });

      expect(route.type).toBe("planning_needed");
      if (route.type === "planning_needed") {
        expect(route.contexts).toEqual(["media"]);
        expect(route.output.plan.candidateActions).toContain("GENERATE_MEDIA");
      }
    });

    it("promotes simple capability denial to planning and seeds GENERATE_MEDIA for generator invocation", () => {
      const output: V5MessageHandlerOutput = {
        shouldRespond: true,
        plan: {
          reply: "i don't have image gen hooked up here. i can read and describe them, not make them.",
          contexts: ["simple"],
          requiresTool: false,
          candidateActions: [],
        },
      };

      const route = routeMessageHandlerOutput(output, {
        messageText: "can you try urself with image gen?",
      });

      expect(route.type).toBe("planning_needed");
      if (route.type === "planning_needed") {
        expect(route.contexts).toEqual(["media"]);
        expect(route.output.plan.candidateActions).toContain("GENERATE_MEDIA");
      }
    });

    it("does not promote technical image request from simple path", () => {
      const output: V5MessageHandlerOutput = {
        shouldRespond: true,
        plan: {
          reply: "Run docker build -t my-tag . to regenerate the tag.",
          contexts: ["simple"],
          requiresTool: false,
          candidateActions: [],
        },
      };

      const route = routeMessageHandlerOutput(output, {
        messageText: "regenerate the docker image tag",
      });

      expect(route.type).toBe("final_reply");
      expect(output.plan.candidateActions).not.toContain("GENERATE_MEDIA");
    });

    it("does not promote capability inquiry from simple path", () => {
      const output: V5MessageHandlerOutput = {
        shouldRespond: true,
        plan: {
          reply: "No, image gen is currently not configured for this room.",
          contexts: ["simple"],
          requiresTool: false,
          candidateActions: [],
        },
      };

      const route = routeMessageHandlerOutput(output, {
        messageText: "do you have image gen?",
      });

      expect(route.type).toBe("final_reply");
      expect(output.plan.candidateActions).not.toContain("GENERATE_MEDIA");
    });
  });
});
