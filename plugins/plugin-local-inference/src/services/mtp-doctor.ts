/**
 * Diagnostic that reports whether multi-token-prediction (MTP) tiers are
 * runnable on this host: it walks the MTP catalog entries, checks the hardware
 * probe, and emits pass/warn/fail checks with fix hints for the model settings
 * UI and CLI doctor.
 */
import {
	ELIZA_1_HOSTED_MTP_TIER_IDS,
	ELIZA_1_MTP_TIER_IDS,
	MODEL_CATALOG,
} from "./catalog";
import { probeHardware } from "./hardware";

export type MtpDoctorCheckStatus = "pass" | "warn" | "fail";

export interface MtpDoctorCheck {
	label: string;
	status: MtpDoctorCheckStatus;
	detail: string;
	fix?: string;
}

export interface MtpDoctorReport {
	ok: boolean;
	checks: MtpDoctorCheck[];
}

export async function runMtpDoctor(): Promise<MtpDoctorReport> {
	const checks: MtpDoctorCheck[] = [];
	const mtpCatalogEntries = MODEL_CATALOG.filter(
		(entry) => entry.runtime?.mtp !== undefined,
	);

	checks.push({
		label: "catalog metadata",
		status: mtpCatalogEntries.length > 0 ? "pass" : "fail",
		detail:
			mtpCatalogEntries.length > 0
				? `${mtpCatalogEntries.length} MTP-capable model entries found`
				: `No catalog entries advertise runtime.mtp; ${ELIZA_1_HOSTED_MTP_TIER_IDS.length}/${ELIZA_1_MTP_TIER_IDS.length} Gemma MTP drafter tiers have hosted GGUFs`,
		fix:
			mtpCatalogEntries.length > 0
				? undefined
				: "publish Gemma drafter GGUFs at bundles/<tier>/mtp/drafter-<tier>.gguf before enabling runtime MTP",
	});

	try {
		const hardware = await probeHardware();
		const backend = hardware.gpu?.backend ?? "cpu";
		checks.push({
			label: "hardware probe",
			status: "pass",
			detail: `${hardware.platform}/${hardware.arch}, backend=${backend}, ram=${hardware.totalRamGb}GB`,
		});
		if (backend === "cpu") {
			checks.push({
				label: "accelerator",
				status: "warn",
				detail:
					"No GPU backend detected; MTP can run but may not improve latency",
				fix: "install a Metal/CUDA/Vulkan-capable llama.cpp runtime",
			});
		}
	} catch (error) {
		checks.push({
			label: "hardware probe",
			status: "warn",
			detail: error instanceof Error ? error.message : String(error),
		});
	}

	checks.push({
		label: "runtime mode",
		status:
			process.env.ELIZA_LOCAL_INFERENCE_BACKEND === "capacitor-llama"
				? "warn"
				: "pass",
		detail:
			process.env.ELIZA_LOCAL_INFERENCE_BACKEND === "capacitor-llama"
				? "Backend override forces capacitor-llama, bypassing optimized llama.cpp MTP"
				: "No backend override is blocking optimized llama.cpp selection",
		fix:
			process.env.ELIZA_LOCAL_INFERENCE_BACKEND === "capacitor-llama"
				? "unset ELIZA_LOCAL_INFERENCE_BACKEND"
				: undefined,
	});

	return {
		ok: checks.every((check) => check.status !== "fail"),
		checks,
	};
}
