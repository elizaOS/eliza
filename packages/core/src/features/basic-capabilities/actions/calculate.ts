/**
 * CALCULATE — deterministic arithmetic for the chat surface. Language models
 * reliably miscompute multi-digit arithmetic (live 2026-08-24: "3847 times
 * 292" drew three different wrong products across the simple and planner
 * paths), and the chat action surface carries no other compute tool: shell is
 * gate-rejected from chat and a coding sub-agent is a build, not a
 * calculator. The handler parses the expression itself — recursive descent,
 * no eval/Function — so the result is arithmetic, not model recall.
 *
 * Integer-only expressions (+ - * % and non-negative integer ^) evaluate in
 * BigInt and are exact within the explicit resource boundary below. Anything
 * involving division or decimals evaluates in floats and says so. Unsupported
 * or oversized input is a typed rejection — never a guess or partial result.
 */
import type {
	Action,
	ActionResult,
	HandlerOptions,
	IAgentRuntime,
	Memory,
	State,
} from "../../../types/index.ts";
import { hasActionContext } from "../../../utils/action-validation.ts";

type Num = { kind: "int"; value: bigint } | { kind: "float"; value: number };

const MAX_EXPRESSION_CHARS = 10_000;
const MAX_INTEGER_RESULT_DIGITS = 10_000;

const integerDigits = (value: bigint): number =>
	(value < 0n ? -value : value).toString().length;

const int = (value: bigint): Num => {
	if (integerDigits(value) > MAX_INTEGER_RESULT_DIGITS) {
		throw new ExpressionError(
			`Integer result is too large (max ${MAX_INTEGER_RESULT_DIGITS} digits)`,
		);
	}
	return { kind: "int", value };
};
const flt = (value: number): Num => ({ kind: "float", value });
const toFloat = (n: Num): number =>
	n.kind === "int" ? Number(n.value) : n.value;

class ExpressionError extends Error {}

/** Recursive-descent evaluator over + - * / % ^ ( ) with unary minus. */
class Parser {
	private pos = 0;
	constructor(private readonly src: string) {}

	parse(): Num {
		const value = this.expression();
		this.ws();
		if (this.pos < this.src.length) {
			throw new ExpressionError(
				`Unexpected "${this.src[this.pos]}" at position ${this.pos + 1}`,
			);
		}
		return value;
	}

	private ws(): void {
		while (this.pos < this.src.length && /\s/.test(this.src[this.pos] ?? "")) {
			this.pos++;
		}
	}

	private expression(): Num {
		let left = this.term();
		for (;;) {
			this.ws();
			const op = this.src[this.pos];
			if (op !== "+" && op !== "-") return left;
			this.pos++;
			const right = this.term();
			if (left.kind === "int" && right.kind === "int") {
				left = int(
					op === "+" ? left.value + right.value : left.value - right.value,
				);
			} else {
				const l = toFloat(left);
				const r = toFloat(right);
				left = flt(op === "+" ? l + r : l - r);
			}
		}
	}

	private term(): Num {
		let left = this.unary();
		for (;;) {
			this.ws();
			const op = this.src[this.pos];
			const twoChar = this.src.slice(this.pos, this.pos + 2);
			if (op === "*" && twoChar !== "**") {
				this.pos++;
				const right = this.unary();
				left =
					left.kind === "int" && right.kind === "int"
						? int(left.value * right.value)
						: flt(toFloat(left) * toFloat(right));
			} else if (op === "/") {
				this.pos++;
				const right = this.unary();
				const divisor = toFloat(right);
				if (divisor === 0) throw new ExpressionError("Division by zero");
				left = flt(toFloat(left) / divisor);
			} else if (op === "%") {
				this.pos++;
				const right = this.unary();
				if (left.kind === "int" && right.kind === "int") {
					if (right.value === 0n) throw new ExpressionError("Division by zero");
					left = int(left.value % right.value);
				} else {
					const divisor = toFloat(right);
					if (divisor === 0) throw new ExpressionError("Division by zero");
					left = flt(toFloat(left) % divisor);
				}
			} else {
				return left;
			}
		}
	}

	private unary(): Num {
		this.ws();
		const ch = this.src[this.pos];
		if (ch === "-") {
			this.pos++;
			const value = this.unary();
			return value.kind === "int" ? int(-value.value) : flt(-value.value);
		}
		if (ch === "+") {
			this.pos++;
			return this.unary();
		}
		return this.power();
	}

	private power(): Num {
		const base = this.primary();
		this.ws();
		const isCaret = this.src[this.pos] === "^";
		const isStarStar = this.src.slice(this.pos, this.pos + 2) === "**";
		if (!isCaret && !isStarStar) return base;
		this.pos += isStarStar ? 2 : 1;
		// Right-associative; guard runaway integer exponents (10^6 digits is
		// already far past anything a chat answer can carry).
		const exponent = this.unary();
		if (
			base.kind === "int" &&
			exponent.kind === "int" &&
			exponent.value >= 0n
		) {
			if (exponent.value > 10_000n) {
				throw new ExpressionError("Exponent too large (max 10000)");
			}
			const absoluteBase = base.value < 0n ? -base.value : base.value;
			if (
				absoluteBase > 1n &&
				BigInt(integerDigits(absoluteBase)) * exponent.value >
					BigInt(MAX_INTEGER_RESULT_DIGITS)
			) {
				throw new ExpressionError(
					`Integer result is too large (max ${MAX_INTEGER_RESULT_DIGITS} digits)`,
				);
			}
			return int(base.value ** exponent.value);
		}
		return flt(toFloat(base) ** toFloat(exponent));
	}

	private primary(): Num {
		this.ws();
		const ch = this.src[this.pos];
		if (ch === "(") {
			this.pos++;
			const inner = this.expression();
			this.ws();
			if (this.src[this.pos] !== ")") {
				throw new ExpressionError("Missing closing parenthesis");
			}
			this.pos++;
			return inner;
		}
		const match = /^\d(?:\d|[,_](?=\d))*(?:\.\d+)?/.exec(
			this.src.slice(this.pos),
		);
		if (!match) {
			throw new ExpressionError(
				`Expected a number at position ${this.pos + 1}`,
			);
		}
		this.pos += match[0].length;
		const literal = match[0].replace(/[_,]/g, "");
		return literal.includes(".")
			? flt(Number.parseFloat(literal))
			: int(BigInt(literal));
	}
}

/** Public for tests: evaluate one expression string. Throws ExpressionError. */
export function evaluateArithmetic(expression: string): {
	text: string;
	exact: boolean;
} {
	if (expression.length > MAX_EXPRESSION_CHARS) {
		throw new ExpressionError(
			`Expression is too large (max ${MAX_EXPRESSION_CHARS} characters)`,
		);
	}
	const result = new Parser(expression).parse();
	if (result.kind === "int") {
		return { text: result.value.toString(), exact: true };
	}
	if (!Number.isFinite(result.value)) {
		throw new ExpressionError("Result is not a finite number");
	}
	// 15 significant digits — the float's own faithful precision, disclosed.
	return { text: String(Number(result.value.toPrecision(15))), exact: false };
}

function resolveExpression(options?: HandlerOptions): string | undefined {
	const raw =
		options?.parameters && typeof options.parameters === "object"
			? (options.parameters as Record<string, unknown>).expression
			: undefined;
	return typeof raw === "string" && raw.trim() ? raw.trim() : undefined;
}

export const calculateAction: Action = {
	name: "CALCULATE",
	contexts: ["general"],
	description:
		"Exact arithmetic: evaluates a numeric expression (+ - * / % ^ parentheses, decimals, unary minus) deterministically. Use for ANY multi-digit arithmetic instead of computing in your head — model mental math is unreliable and supported integer results are exact.",
	descriptionCompressed:
		"exact arithmetic eval; use for any multi-digit math instead of mental math",
	similes: ["MATH", "COMPUTE", "ARITHMETIC", "MULTIPLY", "DIVIDE", "EVAL_MATH"],
	parameters: [
		{
			name: "expression",
			description:
				'The bare numeric expression to evaluate, e.g. "3847 * 292" or "(12.5 + 3) / 4". Numbers and + - * / % ^ ( ) only — no words, no variables.',
			required: true,
			schema: { type: "string" as const },
		},
	],
	validate: async (
		_runtime: IAgentRuntime,
		message: Memory,
		state?: State,
	): Promise<boolean> =>
		hasActionContext(message, state, { contexts: ["general"] }),
	handler: async (
		_runtime: IAgentRuntime,
		_message: Memory,
		_state?: State,
		options?: HandlerOptions,
	): Promise<ActionResult> => {
		const expression = resolveExpression(options);
		if (!expression) {
			return {
				success: false,
				text: 'CALCULATE requires an `expression` parameter, e.g. "3847 * 292".',
				values: { success: false },
				data: {
					actionName: "CALCULATE",
					error: "CALCULATE_MISSING_EXPRESSION",
				},
			};
		}
		try {
			const { text, exact } = evaluateArithmetic(expression);
			return {
				success: true,
				text: `${expression} = ${text}${exact ? "" : " (floating-point; 15 significant digits)"}`,
				values: { success: true, result: text, exact },
				data: { actionName: "CALCULATE", expression, result: text, exact },
			};
		} catch (error) {
			// error-policy:J3 untrusted expression text parses to an explicit
			// invalid result — never a guessed number.
			const reason =
				error instanceof ExpressionError ? error.message : "unparseable input";
			return {
				success: false,
				text: `CALCULATE could not evaluate "${expression}": ${reason}. Supported: numbers with + - * / % ^ and parentheses.`,
				values: { success: false },
				data: {
					actionName: "CALCULATE",
					error: "CALCULATE_INVALID_EXPRESSION",
					expression,
					reason,
				},
			};
		}
	},
};
