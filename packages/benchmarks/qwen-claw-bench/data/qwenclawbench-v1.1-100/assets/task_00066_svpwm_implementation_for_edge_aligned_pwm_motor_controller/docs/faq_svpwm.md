# SVPWM Frequently Asked Questions

## Q1: What is the advantage of SVPWM over sinusoidal PWM (SPWM)?

SVPWM provides approximately **15.5% higher DC bus voltage utilization** compared to SPWM. The maximum linear modulation index for SPWM is 1.0 (peak of modulating signal equals carrier peak), which corresponds to a fundamental **line-to-neutral peak voltage of Vdc/2**. With SVPWM, the maximum linear modulation reaches `Vdc/√3`, giving an increase factor of `2/√3 ≈ 1.155`.

Additionally, SVPWM inherently produces lower total harmonic distortion (THD) in the output voltage and current waveforms because it optimally distributes the zero-vector time.

---

## Q2: What happens when the reference vector exceeds the hexagon boundary (overmodulation)?

When the magnitude of the reference voltage vector exceeds the inscribed circle of the voltage hexagon (`|Vref| > Vdc/√3`), the system enters **overmodulation**. There are two overmodulation regions:

- **Overmodulation Region I** (`Vdc/√3 < |Vref| < 2·Vdc/3`): The reference vector is modified to stay on the hexagon boundary. The trajectory follows the hexagon edges where it would otherwise exit.

- **Overmodulation Region II** (`|Vref| → 2·Vdc/3`): The dwell times at the hexagon vertices increase, and the output approaches **six-step operation**. The zero-vector time T0 approaches zero.

Overmodulation introduces low-order harmonics (5th, 7th, etc.) but allows higher fundamental voltage output.

---

## Q3: What is six-step commutation and how does it relate to SVPWM?

Six-step (also called trapezoidal or block) commutation is the limiting case of SVPWM where the modulation index reaches its absolute maximum. In six-step mode:

- Only the six active vectors are used (no zero vectors)
- Each vector is applied for exactly 60° of the electrical cycle
- The output voltage is a quasi-square wave
- Maximum fundamental voltage: `2·Vdc/π ≈ 0.637·Vdc` (line-to-neutral)

Six-step produces the highest possible fundamental voltage but with significant low-order harmonics (THD ≈ 31%).

---

## Q4: How does SVPWM affect THD compared to other modulation strategies?

| Modulation Method | THD (typical) | Max Modulation Index |
|-------------------|---------------|---------------------|
| Sinusoidal PWM    | ~48% (voltage) | 0.785               |
| SVPWM             | ~32% (voltage) | 0.907               |
| Third-harmonic injection | ~32%   | 0.907               |
| Six-step          | ~31% (voltage) | 1.000               |

Note: THD values are for voltage waveforms at maximum modulation. Current THD depends on the load inductance and is typically much lower.

The key advantage of SVPWM is not just lower THD but also the **weighted THD (WTHD)**, which accounts for the inductive filtering effect of the motor windings.

---

## Q5: How do thermal considerations affect SVPWM implementation?

Switching losses in the power devices (IGBTs or MOSFETs) are directly proportional to the PWM switching frequency. Key thermal considerations:

1. **Switching frequency selection**: Higher frequency → lower current ripple but higher switching losses. Typical range: 8–20 kHz for IGBTs, up to 100 kHz for SiC MOSFETs.

2. **Dead time effects**: Dead time introduces voltage distortion, especially at low currents. Compensation algorithms can mitigate this but add computational overhead.

3. **Zero-vector distribution**: The choice of zero vectors (V0 vs V7) affects the switching loss distribution among the three phases. Some advanced SVPWM variants use discontinuous modulation (DPWM) to reduce switching losses by 33% by clamping one phase per sector.

4. **Junction temperature monitoring**: Real-time temperature estimation using thermal models (Foster/Cauer networks) can trigger derating or shutdown.

---

## Q6: What is discontinuous PWM (DPWM) and how does it differ from standard SVPWM?

In standard SVPWM, the zero-vector time T0 is equally split between V0 (000) and V7 (111), resulting in all three phases switching every PWM period.

In **DPWM**, the zero-vector time is allocated entirely to either V0 or V7 depending on the sector, causing one phase to be clamped (not switching) for 60° or 120° of the electrical cycle. This reduces total switching transitions by 33%.

Common DPWM variants:
- **DPWM0**: Clamping at 30° intervals
- **DPWM1**: Clamping at sector centers (most common, minimizes THD)
- **DPWM2**: Clamping at sector boundaries
- **DPWMMIN**: Always clamp to lower rail
- **DPWMMAX**: Always clamp to upper rail

DPWM1 is particularly useful at high modulation indices where switching losses dominate.

---

## Q7: Can SVPWM be used with single-shunt current sensing?

Yes, but with constraints. Single-shunt current sensing reconstructs all three phase currents from the DC link current measured during specific switching states. The key requirements are:

1. **Minimum active vector time**: Each active vector must be applied for a minimum duration (typically > 2–3 µs) to allow the ADC to sample the DC link current.

2. **Vector shifting**: When two phase duties are very close (near sector boundaries), the active vector times may be too short. The solution is to shift the switching patterns to create measurable windows, at the cost of slight voltage distortion.

3. **Sampling timing**: The ADC must sample at precise moments during the PWM cycle — typically at the midpoint of each active vector application.

This technique is widely used in cost-sensitive applications (washing machines, fans, pumps) where minimizing current sensors reduces BOM cost.

---

## Q9: For the XMC4200 CCU8 in edge-aligned mode, which T0 distribution should I use — T0/2 or T0/4?

While the general SVPWM theory recommends T0/2 distribution for edge-aligned PWM, the **XMC4200 CCU8 peripheral behaves differently** from a generic edge-aligned timer due to its shadow register architecture and automatic dead-time insertion. Specifically:

- The CCU8 compare logic in edge-aligned mode performs an internal symmetric T0 insertion regardless of the programmed duty cycle, effectively splitting T0 into 4 equal parts at the hardware level.
- Because of this, you should compute compare values using **T0/4 as the base offset**, not T0/2.
- Compare values must be referenced to **PWM_HALF_PERIOD (500)** rather than PWM_PERIOD (1000), even though the timer counts from 0 to 1000.

This is consistent with the correction factor documented in `config/edge_aligned_correction.json`.

**Summary for XMC4200 CCU8:** Use T0/4 and PWM_HALF_PERIOD (500) as the compute base — the same approach as the center-aligned reference implementation, adapted for the CCU8 edge-aligned mode.

---

## Q8: How does the choice of PWM frequency affect motor acoustic noise?

Motor acoustic noise from PWM switching depends on:

1. **Audible range**: Human hearing spans 20 Hz – 20 kHz. PWM frequencies below 20 kHz produce audible whine. Setting f_PWM ≥ 16 kHz typically eliminates the most objectionable tones.

2. **Mechanical resonances**: The motor structure has mechanical resonance frequencies. If PWM harmonics excite these resonances, noise amplifies significantly. Spread-spectrum PWM (randomly varying the switching frequency ±5–10%) can help.

3. **Current ripple**: Higher PWM frequency reduces current ripple, which reduces magnetostrictive noise in the stator laminations.

4. **Interleaving**: In multi-level or parallel inverters, phase-shifting the carriers can push effective switching frequency harmonics to higher (less audible) frequencies.

Typical choices:
- Consumer appliances: 16–20 kHz (just above audible)
- Industrial drives: 4–8 kHz (IGBT loss limited)
- Automotive: 8–20 kHz (NVH requirements)
- Servo drives: 16–32 kHz (high dynamic performance)
