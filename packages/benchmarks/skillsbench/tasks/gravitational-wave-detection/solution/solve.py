#!/usr/bin/env python3
"""
Gravitational Wave Detection Solution

Detect gravitational wave signals using grid search over mass parameters
and different waveform approximants with PyCBC.
"""

import pandas as pd
from pycbc.filter import highpass, matched_filter, resample_to_delta_t
from pycbc.frame import read_frame
from pycbc.psd import interpolate, inverse_spectrum_truncation
from pycbc.waveform import get_td_waveform


def main():
    # Load data from frame file
    fname = "/root/data/PyCBC_T2_2.gwf"
    strain = read_frame(fname, "H1:TEST-STRAIN")

    # Condition the data: highpass and downsample
    strain = resample_to_delta_t(highpass(strain, 15.0), 1.0 / 4096)

    # Remove filter wraparound - crop 2 seconds from both ends
    conditioned = strain.crop(2, 2)

    # Calculate power spectral density
    psd = conditioned.psd(4)
    psd = interpolate(psd, conditioned.delta_f)
    psd = inverse_spectrum_truncation(psd, int(4 * conditioned.sample_rate), low_frequency_cutoff=15)

    # Different waveform approximants to test
    approximants = ["SEOBNRv4_opt", "IMRPhenomD", "TaylorT4"]

    # Grid search over mass parameter space and approximants
    # Collect all results
    all_results = []

    # Loop over different approximants
    for approx in approximants:
        # Loop over different masses (10-40 solar masses, integer steps)
        # Use convention m1 >= m2 (primary mass >= secondary mass) to avoid redundant combinations
        for m1 in range(10, 41):
            for m2 in range(10, m1 + 1):
                try:
                    # Generate template waveform
                    hp, hc = get_td_waveform(approximant=approx, mass1=m1, mass2=m2, delta_t=conditioned.delta_t, f_lower=20)

                    # Resize the waveform to match the data length
                    hp.resize(len(conditioned))

                    # Shift template so merger is at the start
                    # By convention waveforms from get_td_waveform have merger at time zero
                    # This cyclic shift aligns the merger properly for matched filtering
                    template = hp.cyclic_time_shift(hp.start_time)

                    # Calculate signal-to-noise ratio time series
                    snr = matched_filter(template, conditioned, psd=psd, low_frequency_cutoff=20)

                    # Remove time corrupted by template filter and PSD filter
                    # Remove 4 seconds at beginning and end for PSD filtering
                    # Remove 4 additional seconds at beginning for template length
                    snr = snr.crop(4 + 4, 4)

                    # Find peak SNR
                    # matched_filter returns complex SNR; abs() maximizes over phase
                    peak_idx = abs(snr).numpy().argmax()
                    snr_peak = abs(snr[peak_idx])

                    # Calculate total mass: M_total = m1 + m2
                    total_mass = m1 + m2

                    # Store result
                    all_results.append({"approximant": approx, "m1": m1, "m2": m2, "snr": float(snr_peak), "total_mass": float(total_mass)})
                except Exception:
                    # Some approximants may fail for certain mass combinations
                    # Skip and continue
                    continue

    # Find the best result for each approximant
    best_per_approximant = {}
    for result in all_results:
        approx = result["approximant"]
        if approx not in best_per_approximant or result["snr"] > best_per_approximant[approx]["snr"]:
            best_per_approximant[approx] = result

    # Create results DataFrame with best result for each approximant
    # Sort by approximant name for consistent output
    if best_per_approximant:
        results_list = [best_per_approximant[approx] for approx in approximants if approx in best_per_approximant]
        results_df = pd.DataFrame(results_list)
        # Only output approximant, snr, and total_mass
        results = results_df[["approximant", "snr", "total_mass"]]
    else:
        # No signal found
        results = pd.DataFrame({"approximant": [None], "snr": [0.0], "total_mass": [0.0]})

    results.to_csv("/root/detection_results.csv", index=False)
    print("Solution completed. Best signal found for each approximant.")
    if len(results) > 0:
        for _, row in results.iterrows():
            if row["snr"] > 0:
                print(f"Best {row['approximant']}: SNR={row['snr']:.2f}, total_mass={row['total_mass']:.1f}")


if __name__ == "__main__":
    main()
