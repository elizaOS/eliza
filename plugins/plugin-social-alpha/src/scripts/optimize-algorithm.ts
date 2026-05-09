#!/usr/bin/env node
/**
 * Optimize Trust Score Algorithm
 *
 * This script optimizes the trust score algorithm parameters:
 * 1. Run simulations with different actor types
 * 2. Test various parameter combinations
 * 3. Find the best parameters that minimize error
 * 4. Generate optimization report
 *
 * Usage:
 *   npm run optimize-algorithm [--cache] [--quick] [--output <dir>]
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { parseArgs } from "node:util";
import { SimulationService } from "../services/SimulationService";
import { TrustScoreService } from "../services/TrustScoreService";

// Parse command line arguments
const { values } = parseArgs({
	args: process.argv.slice(2),
	options: {
		cache: { type: "boolean", default: true },
		quick: { type: "boolean", default: false },
		output: { type: "string", default: "./optimization-results" },
	},
});

const USE_CACHE = values.cache as boolean;
const QUICK_MODE = values.quick as boolean;
const OUTPUT_DIR = values.output as string;

/**
 * Run optimization with progress tracking
 */
async function runOptimization() {
	console.log("🚀 Starting Trust Score Algorithm Optimization\n");
	console.log(`   Mode: ${QUICK_MODE ? "Quick" : "Full"}`);
	console.log(`   Cache: ${USE_CACHE ? "Enabled" : "Disabled"}`);
	console.log(`   Output: ${OUTPUT_DIR}\n`);

	// Create output directory
	await fs.mkdir(OUTPUT_DIR, { recursive: true });

	// Initialize services
	const trustService = new TrustScoreService();
	const simulationService = new SimulationService();

	// Define parameter ranges
	const parameterRanges = QUICK_MODE
		? {
				// Quick mode: fewer combinations
				profitWeight: [0.2, 0.25, 0.3],
				winRateWeight: [0.2, 0.25],
				sharpeWeight: [0.1, 0.15],
				alphaWeight: [0.1],
				consistencyWeight: [0.1],
				qualityWeight: [0.15, 0.2],
			}
		: {
				// Full mode: comprehensive search
				profitWeight: [0.15, 0.2, 0.25, 0.3, 0.35],
				winRateWeight: [0.15, 0.2, 0.25, 0.3],
				sharpeWeight: [0.05, 0.1, 0.15, 0.2],
				alphaWeight: [0.05, 0.1, 0.15],
				consistencyWeight: [0.05, 0.1, 0.15],
				qualityWeight: [0.1, 0.15, 0.2, 0.25],
			};

	// Calculate total combinations
	const totalCombinations = Object.values(parameterRanges).reduce(
		(acc, range) => acc * range.length,
		1,
	);
	console.log(`📊 Testing ${totalCombinations} parameter combinations\n`);

	// Run simulation if not using cache
	let simulationResult;
	if (!USE_CACHE) {
		console.log("🎮 Running simulation...");
		simulationResult = await simulationService.runTestSimulation();
		console.log("   ✅ Simulation complete\n");
	}

	// Run optimization
	console.log("🔍 Optimizing parameters...");
	const startTime = Date.now();

	const optimizationResult = await trustService.optimizeParameters(
		parameterRanges,
		simulationResult,
	);

	const duration = (Date.now() - startTime) / 1000;
	console.log(`   ✅ Optimization complete in ${duration.toFixed(1)}s\n`);

	// Generate detailed report
	const report = {
		timestamp: new Date().toISOString(),
		mode: QUICK_MODE ? "quick" : "full",
		totalCombinations,
		duration,
		bestParameters: optimizationResult.bestParams,
		bestScore: optimizationResult.bestScore,
		accuracy: optimizationResult.accuracy,
		parameterRanges,
		topConfigurations: optimizationResult.allResults
			.sort((a: any, b: any) => a.score - b.score)
			.slice(0, 10)
			.map((result: any) => ({
				parameters: result.params,
				score: result.score,
				accuracy: result.accuracy,
			})),
	};

	// Save report
	const reportFile = path.join(OUTPUT_DIR, "optimization_report.json");
	await fs.writeFile(reportFile, JSON.stringify(report, null, 2));

	// Save best parameters
	const paramsFile = path.join(OUTPUT_DIR, "best_parameters.json");
	await fs.writeFile(
		paramsFile,
		JSON.stringify(optimizationResult.bestParams, null, 2),
	);

	// Print results
	console.log("📊 Optimization Results:");
	console.log("\n🏆 Best Parameters:");
	Object.entries(optimizationResult.bestParams).forEach(([key, value]) => {
		console.log(`   ${key}: ${value}`);
	});

	console.log("\n📈 Accuracy Metrics:");
	console.log(`   MAE: ${optimizationResult.accuracy.mae.toFixed(2)}`);
	console.log(`   RMSE: ${optimizationResult.accuracy.rmse.toFixed(2)}`);
	console.log(
		`   Correlation: ${optimizationResult.accuracy.correlation.toFixed(3)}`,
	);
	console.log(
		`   Ranking Accuracy: ${optimizationResult.accuracy.rankingAccuracy.toFixed(1)}%`,
	);

	// Generate parameter sensitivity analysis
	await generateSensitivityAnalysis(optimizationResult.allResults, OUTPUT_DIR);

	console.log("\n✅ Optimization complete!");
	console.log(`   Results saved to: ${OUTPUT_DIR}`);
}

/**
 * Generate parameter sensitivity analysis
 */
async function generateSensitivityAnalysis(
	allResults: any[],
	outputDir: string,
): Promise<void> {
	console.log("\n📊 Generating sensitivity analysis...");

	const paramNames = Object.keys(allResults[0].params);
	const sensitivity: Record<string, any> = {};

	// For each parameter, analyze how it affects the score
	for (const paramName of paramNames) {
		const values = new Set(allResults.map((r) => r.params[paramName]));
		const valueScores: Record<string, number[]> = {};

		// Group scores by parameter value
		for (const value of values) {
			valueScores[value] = allResults
				.filter((r) => r.params[paramName] === value)
				.map((r) => r.score);
		}

		// Calculate average score for each value
		const avgScores = Object.entries(valueScores).map(([value, scores]) => ({
			value: parseFloat(value),
			avgScore: scores.reduce((sum, s) => sum + s, 0) / scores.length,
			minScore: Math.min(...scores),
			maxScore: Math.max(...scores),
			count: scores.length,
		}));

		// Sort by value
		avgScores.sort((a, b) => a.value - b.value);

		sensitivity[paramName] = {
			values: avgScores,
			impact:
				Math.max(...avgScores.map((s) => s.avgScore)) -
				Math.min(...avgScores.map((s) => s.avgScore)),
		};
	}

	// Save sensitivity analysis
	const sensitivityFile = path.join(outputDir, "sensitivity_analysis.json");
	await fs.writeFile(sensitivityFile, JSON.stringify(sensitivity, null, 2));

	// Print parameter impact ranking
	const impactRanking = Object.entries(sensitivity)
		.map(([param, data]: [string, any]) => ({ param, impact: data.impact }))
		.sort((a, b) => b.impact - a.impact);

	console.log("\n🎯 Parameter Impact Ranking:");
	impactRanking.forEach((item, index) => {
		console.log(`   ${index + 1}. ${item.param}: ${item.impact.toFixed(3)}`);
	});
}

/**
 * Main function
 */
async function main() {
	try {
		await runOptimization();
	} catch (error) {
		console.error("❌ Error during optimization:", error);
		process.exit(1);
	}
}

// Run if called directly
if (require.main === module) {
	main();
}
