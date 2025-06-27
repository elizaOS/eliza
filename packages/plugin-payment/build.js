#!/usr/bin/env bun
"use strict";
/**
 * Standard plugin build script for ElizaOS
 * Provides consistent build behavior across all plugins
 */
var __makeTemplateObject = (this && this.__makeTemplateObject) || function (cooked, raw) {
    if (Object.defineProperty) { Object.defineProperty(cooked, "raw", { value: raw }); } else { cooked.raw = raw; }
    return cooked;
};
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var __generator = (this && this.__generator) || function (thisArg, body) {
    var _ = { label: 0, sent: function() { if (t[0] & 1) throw t[1]; return t[1]; }, trys: [], ops: [] }, f, y, t, g = Object.create((typeof Iterator === "function" ? Iterator : Object).prototype);
    return g.next = verb(0), g["throw"] = verb(1), g["return"] = verb(2), typeof Symbol === "function" && (g[Symbol.iterator] = function() { return this; }), g;
    function verb(n) { return function (v) { return step([n, v]); }; }
    function step(op) {
        if (f) throw new TypeError("Generator is already executing.");
        while (g && (g = 0, op[0] && (_ = 0)), _) try {
            if (f = 1, y && (t = op[0] & 2 ? y["return"] : op[0] ? y["throw"] || ((t = y["return"]) && t.call(y), 0) : y.next) && !(t = t.call(y, op[1])).done) return t;
            if (y = 0, t) op = [op[0] & 2, t.value];
            switch (op[0]) {
                case 0: case 1: t = op; break;
                case 4: _.label++; return { value: op[1], done: false };
                case 5: _.label++; y = op[1]; op = [0]; continue;
                case 7: op = _.ops.pop(); _.trys.pop(); continue;
                default:
                    if (!(t = _.trys, t = t.length > 0 && t[t.length - 1]) && (op[0] === 6 || op[0] === 2)) { _ = 0; continue; }
                    if (op[0] === 3 && (!t || (op[1] > t[0] && op[1] < t[3]))) { _.label = op[1]; break; }
                    if (op[0] === 6 && _.label < t[1]) { _.label = t[1]; t = op; break; }
                    if (t && _.label < t[2]) { _.label = t[2]; _.ops.push(op); break; }
                    if (t[2]) _.ops.pop();
                    _.trys.pop(); continue;
            }
            op = body.call(thisArg, _);
        } catch (e) { op = [6, e]; y = 0; } finally { f = t = 0; }
        if (op[0] & 5) throw op[1]; return { value: op[0] ? op[1] : void 0, done: true };
    }
};
Object.defineProperty(exports, "__esModule", { value: true });
var bun_1 = require("bun");
var core_1 = require("@elizaos/core");
function build() {
    return __awaiter(this, void 0, void 0, function () {
        var buildConfig, configModule, _a, result, _i, _b, message, _error_1;
        return __generator(this, function (_c) {
            switch (_c.label) {
                case 0:
                    console.log('🏗️  Building plugin...');
                    // Clean dist directory
                    return [4 /*yield*/, (0, bun_1.$)(templateObject_1 || (templateObject_1 = __makeTemplateObject(["rm -rf dist"], ["rm -rf dist"])))];
                case 1:
                    // Clean dist directory
                    _c.sent();
                    _c.label = 2;
                case 2:
                    _c.trys.push([2, 4, , 5]);
                    return [4 /*yield*/, Promise.resolve().then(function () { return require('./build.config'); })];
                case 3:
                    configModule = _c.sent();
                    buildConfig = configModule.buildConfig;
                    return [3 /*break*/, 5];
                case 4:
                    _a = _c.sent();
                    // Fallback to default config
                    buildConfig = (0, core_1.createPluginConfig)(['./src/index.ts']);
                    return [3 /*break*/, 5];
                case 5: return [4 /*yield*/, Bun.build(buildConfig)];
                case 6:
                    result = _c.sent();
                    if (!result.success) {
                        console.error('❌ Build failed:');
                        for (_i = 0, _b = result.logs; _i < _b.length; _i++) {
                            message = _b[_i];
                            console.error(message);
                        }
                        process.exit(1);
                    }
                    console.log("\u2705 Built ".concat(result.outputs.length, " files"));
                    // Generate TypeScript declarations
                    console.log('📝 Generating TypeScript declarations...');
                    _c.label = 7;
                case 7:
                    _c.trys.push([7, 9, , 10]);
                    return [4 /*yield*/, (0, bun_1.$)(templateObject_2 || (templateObject_2 = __makeTemplateObject(["tsc --project tsconfig.json"], ["tsc --project tsconfig.json"])))];
                case 8:
                    _c.sent();
                    console.log('✅ TypeScript declarations generated');
                    return [3 /*break*/, 10];
                case 9:
                    _error_1 = _c.sent();
                    console.warn('⚠️ TypeScript declaration generation had issues, but continuing...');
                    return [3 /*break*/, 10];
                case 10:
                    console.log('✅ Plugin build complete!');
                    return [2 /*return*/];
            }
        });
    });
}
build().catch(console.error);
var templateObject_1, templateObject_2;
