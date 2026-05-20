import { Next } from "koa";
import { RouterContext } from "koa-router";
import { ValidateInput, ValidateJSON } from ".";

export class SettingsValidator {
    static rules = {
        name: "required|string|min:3|max:50",
        data: "required"
    };

    static deleteRules = {
        name: "required|string|min:3|max:50",
    };

    static async validate(ctx: RouterContext, next: Next) {
        const { data } = ValidateInput(ctx.request.body, SettingsValidator.rules);
        ValidateJSON(data, "Settings");
        await next();
    }

    static async validateDelete(ctx: RouterContext, next: Next) {
        ValidateInput(ctx.request.body, SettingsValidator.deleteRules);
        await next();
    }
}
