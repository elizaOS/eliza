import { describe, expect, it } from "vitest";
import { composeContext } from "../context";
import handlebars from "handlebars";
import { State } from "../types.ts";

describe("composeContext", () => {
    const baseState: State = {
        actors: "",
        recentMessages: "",
        recentMessagesData: [],
        roomId: "-----",
        bio: "",
        lore: "",
        messageDirections: "",
        postDirections: "",
        userName: "",
    };

    // Test simple string replacement
    describe("simple string replacement (default)", () => {
        it("should replace placeholders with corresponding state values", () => {
            const state: State = {
                ...baseState,
                userName: "Alice",
                userAge: 30,
            };
            const template =
                "Hello, {{userName}}! You are {{userAge}} years old.";

            const result = composeContext({ state, template });

            expect(result).toBe("Hello, Alice! You are 30 years old.");
        });

        it("should replace missing state values with empty string", () => {
            const state: State = {
                ...baseState,
                userName: "Alice",
            };
            const template =
                "Hello, {{userName}}! You are {{userAge}} years old.";

            const result = composeContext({ state, template });

            expect(result).toBe("Hello, Alice! You are  years old.");
        });

        it("should handle templates with no placeholders", () => {
            const state: State = {
                ...baseState,
                userName: "Alice",
            };
            const template = "Hello, world!";

            const result = composeContext({ state, template });

            expect(result).toBe("Hello, world!");
        });

        it("should handle empty template", () => {
            const state: State = {
                ...baseState,
                userName: "Alice",
            };
            const template = "";

            const result = composeContext({ state, template });

            expect(result).toBe("");
        });
    });

    describe("dynamic templates", () => {
        it("should handle function templates", () => {
            const state: State = {
                ...baseState,
                userName: "Alice",
                userAge: 30,
            };
            const template = () => {
                return "Hello, {{userName}}! You are {{userAge}} years old.";
            };

            const result = composeContext({ state, template });

            expect(result).toBe("Hello, Alice! You are 30 years old.");
        });

        it("should handle function templates with conditional logic", () => {
            const state: State = {
                ...baseState,
                userName: "Alice",
                userAge: 30,
            };
            const isEdgy = true;
            const template = () => {
                if (isEdgy) {
                    return "Hello, {{userName}}! You are {{userAge}} years old... whatever";
                }

                return `Hello, {{userName}}! You are {{userAge}} years old`;
            };

            const result = composeContext({ state, template });

            expect(result).toBe(
                "Hello, Alice! You are 30 years old... whatever"
            );
        });

        it("should handle function templates with conditional logic depending on state", () => {
            const template = ({ state }: { state: State }) => {
                if (state.userName) {
                    return `Hello, {{userName}}! You are {{userAge}} years old.`;
                }

                return `Hello, anon! You are {{userAge}} years old.`;
            };

            const result = composeContext({
                state: {
                    ...baseState,
                    userName: "Alice",
                    userAge: 30,
                },
                template,
            });

            const resultWithoutUsername = composeContext({
                state: {
                    ...baseState,
                    userAge: 30,
                },
                template,
            });

            expect(result).toBe("Hello, Alice! You are 30 years old.");
            expect(resultWithoutUsername).toBe(
                "Hello, anon! You are 30 years old."
            );
        });

        it("should handle function templates with handlebars templating engine", () => {
            const state: State = {
                ...baseState,
                userName: "Alice",
                userAge: 30,
            };
            const template = () => {
                return `{{#if userAge}}Hello, {{userName}}!{{else}}Hi there!{{/if}}`;
            };

            const result = composeContext({
                state,
                template,
                templatingEngine: "handlebars",
            });

            expect(result).toBe("Hello, Alice!");
        });
    });

    // Test Handlebars templating
    describe("handlebars templating", () => {
        it("should process basic handlebars template", () => {
            const state: State = {
                ...baseState,
                userName: "Alice",
                userAge: 30,
            };
            const template =
                "Hello, {{userName}}! You are {{userAge}} years old.";

            const result = composeContext({
                state,
                template,
                templatingEngine: "handlebars",
            });

            expect(result).toBe("Hello, Alice! You are 30 years old.");
        });

        it("should handle handlebars conditionals", () => {
            const state: State = {
                ...baseState,
                userName: "Alice",
                userAge: 30,
            };
            const template =
                "{{#if userAge}}Age: {{userAge}}{{else}}Age unknown{{/if}}";

            const result = composeContext({
                state,
                template,
                templatingEngine: "handlebars",
            });

            expect(result).toBe("Age: 30");
        });

        it("should handle handlebars loops", () => {
            const state: State = {
                ...baseState,
                colors: ["red", "blue", "green"],
            };
            const template =
                "{{#each colors}}{{this}}{{#unless @last}}, {{/unless}}{{/each}}";

            const result = composeContext({
                state,
                template,
                templatingEngine: "handlebars",
            });

            expect(result).toBe("red, blue, green");
        });

        it("should handle complex handlebars template", () => {
            // Register the 'gt' helper before running tests
            handlebars.registerHelper("gt", function (a, b) {
                return a > b;
            });

            const state = {
                ...baseState,
                userName: "Alice",
                userAge: 30,
                favoriteColors: ["blue", "green", "red"],
            };
            const template = `
        {{#if userAge}}
          Hello, {{userName}}! {{#if (gt userAge 18)}}You are an adult.{{else}}You are a minor.{{/if}}
        {{else}}
          Hello! We don't know your age.
        {{/if}}
        {{#each favoriteColors}}
          - {{this}}
        {{/each}}`;

            const result = composeContext({
                state,
                template,
                templatingEngine: "handlebars",
            });

            expect(result.trim()).toMatch(/Hello, Alice! You are an adult./);
            expect(result).toContain("- blue");
            expect(result).toContain("- green");
            expect(result).toContain("- red");
        });

        it("should handle missing values in handlebars template", () => {
            const state = { ...baseState };
            const template = "Hello, {{userName}}!";

            const result = composeContext({
                state,
                template,
                templatingEngine: "handlebars",
            });

            expect(result).toBe("Hello, !");
        });
    });

    describe("error handling", () => {
        it("should handle undefined state", () => {
            const template = "Hello, {{userName}}!";

            expect(() => {
                // @ts-expect-error testing undefined state
                composeContext({ template });
            }).toThrow();
        });

        it("should handle undefined template", () => {
            const state = {
                ...baseState,
                userName: "Alice",
            };

            expect(() => {
                // @ts-expect-error testing undefined template
                composeContext({ state });
            }).toThrow();
        });
    });
});
