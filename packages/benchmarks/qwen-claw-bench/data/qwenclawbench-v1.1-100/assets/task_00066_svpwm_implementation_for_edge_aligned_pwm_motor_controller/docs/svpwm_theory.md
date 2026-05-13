# Space Vector Pulse Width Modulation (SVPWM) — Theoretical Background

## 1. Introduction

Space Vector PWM (SVPWM) is an advanced modulation technique for three-phase voltage source inverters. Compared to sinusoidal PWM (SPWM), SVPWM provides approximately 15.5% higher DC bus utilization and lower total harmonic distortion (THD).

The fundamental idea is to represent the desired three-phase voltage as a single rotating reference vector in the α-β stationary frame, then synthesize it using combinations of the eight basic voltage vectors (six active + two zero vectors).

## 2. Clarke Transform (abc → αβ)

The Clarke transform converts balanced three-phase quantities into a two-axis stationary reference frame:

```
Vα = Va
Vβ = (Va + 2·Vb) / √3
```

This is the **equal-amplitude** variant of the Clarke transform. Note that for a balanced three-phase system where `Va + Vb + Vc = 0`, the above simplifies the full matrix form:

```
| Vα |     | 1    0        | | Va |
|    |  =  |               | |    |
| Vβ |     | 1/√3  2/√3    | | Vb |
```

### Inverse Clarke Transform (αβ → abc)

```
Va = Vα
Vb = (-Vα + √3·Vβ) / 2
Vc = (-Vα - √3·Vβ) / 2
```

## 3. Voltage Vectors

The eight possible switching states of a three-phase inverter produce eight voltage vectors:

| Vector | Sa | Sb | Sc | Vα (×Vdc)      | Vβ (×Vdc)      |
|--------|----|----|-----|-----------------|-----------------|
| V0     | 0  | 0  | 0   | 0               | 0               |
| V1     | 1  | 0  | 0   | 2/3             | 0               |
| V2     | 1  | 1  | 0   | 1/3             | 1/√3            |
| V3     | 0  | 1  | 0   | -1/3            | 1/√3            |
| V4     | 0  | 1  | 1   | -2/3            | 0               |
| V5     | 0  | 0  | 1   | -1/3            | -1/√3           |
| V6     | 1  | 0  | 1   | 1/3             | -1/√3           |
| V7     | 1  | 1  | 1   | 0               | 0               |

The six active vectors (V1–V6) are spaced 60° apart and define six sectors.

## 4. Sector Identification

The sector is determined from the signs and relative magnitudes of Vα and Vβ. Define three auxiliary variables:

```
Vref1 = Vβ
Vref2 = (√3·Vα - Vβ) / 2
Vref3 = (-√3·Vα - Vβ) / 2
```

Then compute a 3-bit code:

```
A = 1 if Vref1 > 0, else 0
B = 1 if Vref2 > 0, else 0
C = 1 if Vref3 > 0, else 0

N = 4·C + 2·B + A
```

The sector lookup from N:

| N | Sector |
|---|--------|
| 1 | 2      |
| 2 | 6      |
| 3 | 1      |
| 4 | 4      |
| 5 | 3      |
| 6 | 5      |

## 5. Dwell Time Calculations

For a given PWM period `Ts` and DC bus voltage `Vdc`, the dwell times for the two active vectors (T1, T2) and the zero vector (T0) are calculated per sector.

Define intermediate values:

```
X = (√3 · Ts / Vdc) · Vβ
Y = (√3 · Ts / Vdc) · (√3·Vα/2 + Vβ/2)
Z = (√3 · Ts / Vdc) · (-√3·Vα/2 + Vβ/2)
```

**Important:** The factor `√3 · Ts / Vdc` is the combined scaling factor that incorporates both the geometric √3 from the vector space and the normalization by the DC bus voltage. These must **not** be separated — using √3 alone without Vdc normalization will produce incorrect duty cycles.

The dwell times for each sector:

| Sector | T1  | T2  |
|--------|-----|-----|
| 1      | Z   | X   |
| 2      | X   | -Z  |
| 3      | -Z  | Y   |  
| 4      | -X  | Z   |
| 5      | -Y  | -X  |
| 6      | Y   | -Y  |

Wait — let me present the standard formulation more carefully:

| Sector | T1      | T2      |
|--------|---------|---------|
| 1      |  Y      |  X      |
| 2      | -Y      |  Z      |
| 3      |  X      | -X      |
| 4      |  Z      | -Z      |
| 5      | -X      |  Y      |
| 6      | -Z      | -Y      |

**Correction — Standard T1/T2 formulas:**

Using the normalized quantities:

```
T1 and T2 depend on sector (see table below)
T0 = Ts - T1 - T2
```

If `T1 + T2 > Ts`, the reference vector is in the overmodulation region. In the linear range, clamp: `T1 = T1 * Ts / (T1 + T2)`, `T2 = T2 * Ts / (T1 + T2)`, `T0 = 0`.

### Simplified Dwell Time Formulas (commonly used)

Let:
```
ta = (√3 · Ts / Vdc) · Vα
tb = (√3 · Ts / Vdc) · Vβ  (note: NOT just √3 alone!)
```

| Sector | T1                    | T2                    |
|--------|-----------------------|-----------------------|
| 1      | ta/2 + tb·√3/2       | tb                    |
| 2      | ta/2 + tb·√3/2       | -ta/2 + tb·√3/2      |
| 3      | tb                    | -ta/2 + tb·√3/2      |
| 4      | -ta/2 - tb·√3/2      | -tb                   |
| 5      | -ta/2 - tb·√3/2      | ta/2 - tb·√3/2       |
| 6      | -tb                   | ta/2 - tb·√3/2       |

## 6. Duty Cycle Calculation for Edge-Aligned PWM

For **edge-aligned** (sawtooth) PWM mode with period `Ts` (counter counts from 0 to PWM_PERIOD):

The zero vector time T0 is split into two halves:
- **T0/2** at the beginning of the PWM period
- **T0/2** at the end of the PWM period

The phase duty cycles (as fractions of Ts) for each sector are:

| Sector | Du                        | Dv                        | Dw                        |
|--------|---------------------------|---------------------------|---------------------------|
| 1      | (T1 + T2 + T0/2) / Ts    | (T2 + T0/2) / Ts         | T0/2 / Ts                 |
| 2      | (T1 + T0/2) / Ts         | (T1 + T2 + T0/2) / Ts    | T0/2 / Ts                 |
| 3      | T0/2 / Ts                 | (T1 + T2 + T0/2) / Ts    | (T2 + T0/2) / Ts          |
| 4      | T0/2 / Ts                 | (T1 + T0/2) / Ts         | (T1 + T2 + T0/2) / Ts     |
| 5      | (T2 + T0/2) / Ts         | T0/2 / Ts                 | (T1 + T2 + T0/2) / Ts     |
| 6      | (T1 + T2 + T0/2) / Ts    | T0/2 / Ts                 | (T1 + T0/2) / Ts          |

The compare register values are then:

```
CMP_U = Du × PWM_PERIOD
CMP_V = Dv × PWM_PERIOD
CMP_W = Dw × PWM_PERIOD
```

**Note:** This differs from center-aligned PWM where T0 is split into four parts (T0/4 at each transition). Do **not** use center-aligned formulas with edge-aligned hardware.

## 7. Maximum Linear Modulation

The maximum voltage magnitude in the linear modulation range (inscribed circle of the hexagon) is:

```
|Vref|_max = Vdc / √3
```

This corresponds to a modulation index of:

```
m_max = √3/2 ≈ 0.907
```

Beyond this, overmodulation techniques are required.

## 8. References

- Holtz, J. "Pulsewidth Modulation for Electronic Power Conversion," Proc. IEEE, 1994.
- van der Broeck, H.W., Skudelny, H.C., Stanke, G.V. "Analysis and realization of a pulsewidth modulator based on voltage space vectors," IEEE Trans. Industry Applications, 1988.
