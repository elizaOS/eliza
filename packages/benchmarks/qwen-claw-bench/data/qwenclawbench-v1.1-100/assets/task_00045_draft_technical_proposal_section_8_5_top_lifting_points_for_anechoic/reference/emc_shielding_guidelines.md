# EMC Shielding Design Guidelines
## Penetrations and Attachments to Shielding Enclosures
### Reference: GJB 6190-2008 / IEEE 299 / MIL-STD-188-125-1

---

## 1. General Principle

All penetrations, attachments, and modifications to a shielded enclosure must maintain the electromagnetic integrity of the shielding barrier. The shielding effectiveness (SE) of the enclosure shall not be degraded below the specified performance at any frequency within the design range.

---

## 2. RF Continuity Requirements

### 2.1 Welded Connections
- Continuous welded seams are the preferred method for maintaining RF continuity across shielding joints.
- Weld quality shall be verified by visual inspection and, where specified, by dye-penetrant or ultrasonic testing.
- Weld seams shall be ground flush where they interface with RF gasket surfaces.

### 2.2 Bolted Connections
- Where bolted connections are used through the shielding barrier, bolt spacing shall not exceed λ/20 at the highest frequency of concern.
- Conductive RF gaskets (e.g., beryllium copper finger stock, knitted wire mesh, or conductive elastomer) shall be installed at all bolted joints.
- Bolt torque shall be specified and verified to ensure adequate gasket compression.

### 2.3 Conductive Gaskets
- Gasket material shall be compatible with both mating surfaces to prevent galvanic corrosion.
- Gasket compression shall be maintained within the manufacturer's specified range (typically 20–40% compression).
- Gasket surfaces must be clean, flat, and free of paint, oxide, or other non-conductive coatings.

---

## 3. Dissimilar Metal Contact

### 3.1 Galvanic Corrosion Prevention
- Direct contact between dissimilar metals with a galvanic potential difference exceeding 0.25V shall be avoided.
- Where dissimilar metal contact is unavoidable, the following mitigation measures shall be applied:
  - Apply conductive anti-corrosion compound (e.g., zinc-chromate paste) at the interface
  - Use isolation washers or sleeves where structural loads permit
  - Specify sacrificial anode protection where appropriate

### 3.2 Common Material Pairings
| Base Metal | Compatible Fastener | Incompatible (Avoid) |
|---|---|---|
| Galvanized steel | Zinc-plated steel, stainless (with isolation) | Copper, brass |
| Aluminum | Stainless steel (with isolation), cadmium-plated | Copper, carbon steel |
| Copper | Brass, bronze | Aluminum, zinc |

---

## 4. Lifting Point Attachments — Special Requirements

### 4.1 Slot Antenna Prevention
- Lifting point embed plates, brackets, and mounting hardware attached to or penetrating the shielding enclosure **shall not create slot antennas**.
- A slot antenna is formed when a narrow gap or seam exists in a conductive surface. Gaps longer than λ/10 at the highest frequency of concern will radiate and degrade SE.
- All lifting point mounting interfaces shall be continuously welded or sealed with conductive gaskets to prevent slot formation.

### 4.2 Bonding Resistance
- The bonding resistance between any lifting point hardware and the shielding enclosure shall not exceed **2.5 milliohms** (measured per MIL-STD-1310).
- Bonding resistance shall be measured after installation and documented in the acceptance records.
- Periodic re-measurement is recommended at 12-month intervals.

### 4.3 Penetration Sealing
- Where anchor bolts or structural supports penetrate the shielding barrier, the penetration shall be sealed with:
  - Welded collar or sleeve (preferred), or
  - Conductive caulk and RF gasket combination
- The seal shall be tested for SE at the penetration location. Localized SE shall not be more than 6 dB below the enclosure specification.

### 4.4 Surface Treatment Compatibility
- Hot-dip galvanized lifting point hardware is acceptable for direct contact with galvanized steel shielding panels.
- If the shielding panel is bare (ungalvanized) steel, the lifting point hardware contact surface shall also be bare steel, with conductive anti-corrosion treatment applied after assembly.
- Paint or non-conductive coatings shall be removed from all RF bonding surfaces prior to assembly.

---

## 5. Testing and Verification

### 5.1 Pre-Installation
- Verify material compatibility per Section 3.
- Confirm gasket specifications and availability.
- Review lifting point drawings for slot antenna risk.

### 5.2 Post-Installation
- Measure bonding resistance at each lifting point (target: < 2.5 mΩ).
- Perform localized SE spot-check at representative lifting point locations.
- Document all measurements in the EMC installation verification report.

### 5.3 Acceptance Criteria
- Bonding resistance: ≤ 2.5 milliohms per joint
- Localized SE degradation: ≤ 6 dB below enclosure specification
- No visible gaps or unsealed penetrations

---

*End of guidelines*
