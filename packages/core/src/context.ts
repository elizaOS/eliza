import handlebars from "handlebars";
import { type State } from "./types.ts";
import { names, uniqueNamesGenerator } from "unique-names-generator";

/**
 * Composes a context string by replacing placeholders in a template with corresponding values from the state.
 *
 * This function takes a template string with placeholders in the format `{{placeholder}}` and a state object.
 * It replaces each placeholder with the value from the state object that matches the placeholder's name.
 * If a matching key is not found in the state object for a given placeholder, the placeholder is replaced with an empty string.
 *
 * By default, this function uses a simple string replacement approach. However, when `templatingEngine` is set to `'handlebars'`, it uses Handlebars templating engine instead, compiling the template into a reusable function and evaluating it with the provided state object.
 *
 * @param {Object} params - The parameters for composing the context.
 * @param {State} params.state - The state object containing values to replace the placeholders in the template.
 * @param {string} params.template - The template string containing placeholders to be replaced with state values.
 * @param {"handlebars" | undefined} [params.templatingEngine] - The templating engine to use for compiling and evaluating the template (optional, default: `undefined`).
 * @returns {string} The composed context string with placeholders replaced by corresponding state values.
 *
 * @example
 * // Given a state object and a template
 * const state = { userName: "Alice", userAge: 30 };
 * const template = "Hello, {{userName}}! You are {{userAge}} years old";
 *
 * // Composing the context with simple string replacement will result in:
 * // "Hello, Alice! You are 30 years old."
 * const contextSimple = composeContext({ state, template });
 */
export const composeContext = ({
    state,
    template,
    templatingEngine,
}: {
    state: State;
    template: string;
    templatingEngine?: "handlebars";
}) => {
    if (templatingEngine === "handlebars") {
        const templateFunction = handlebars.compile(template);
        return templateFunction(state);
    }

    // @ts-expect-error match isn't working as expected
    const out = template.replace(/{{\w+}}/g, (match) => {
        const key = match.replace(/{{|}}/g, "");
        return state[key] ?? "";
    });
    return out;
};

/**
 * Adds a header to a body of text.
 *
 * This function takes a header string and a body string and returns a new string with the header prepended to the body.
 * If the body string is empty, the header is returned as is.
 *
 * @param {string} header - The header to add to the body.
 * @param {string} body - The body to which to add the header.
 * @returns {string} The body with the header prepended.
 *
 * @example
 * // Given a header and a body
 * const header = "Header";
 * const body = "Body";
 *
 * // Adding the header to the body will result in:
 * // "Header\nBody"
 * const text = addHeader(header, body);
 */
export const addHeader = (header: string, body: string) => {
    return body.length > 0 ? `${header ? header + "\n" : header}${body}\n` : "";
};

/**
 * Generates a string with random user names populated in a template.
 *
 * This function generates a specified number of random user names and populates placeholders
 * in the provided template with these names. Placeholders in the template should follow the format `{{userX}}`
 * where `X` is the position of the user (e.g., `{{user1}}`, `{{user2}}`).
 *
 * @param {string} params.template - The template string containing placeholders for random user names.
 * @param {number} params.length - The number of random user names to generate.
 * @returns {string} The template string with placeholders replaced by random user names.
 *
 * @example
 * // Given a template and a length
 * const template = "Hello, {{user1}}! Meet {{user2}} and {{user3}}.";
 * const length = 3;
 *
 * // Composing the random user string will result in:
 * // "Hello, John! Meet Alice and Bob."
 * const result = composeRandomUser({ template, length });
 */
export const composeRandomUser = (template: string, length: number) => {
    const exampleNames = Array.from({ length }, () =>
        uniqueNamesGenerator({ dictionaries: [names] })
    );
    let result = template;
    for (let i = 0; i < exampleNames.length; i++) {
        result = result.replaceAll(`{{user${i + 1}}}`, exampleNames[i]);
    }

    return result;
};
