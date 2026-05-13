# CKD Lab Features Dictionary (60 Features)

## 1. Kidney Function (5 features)

| Key | Name | Description | Min | Max | Unit | Conversion |
|-----|------|-------------|-----|-----|------|------------|
| Serum_Creatinine | Serum Creatinine | Waste product from muscle metabolism; primary marker for kidney function | 0.2 | 20.0 | mg/dL | 1 mg/dL = 88.4 µmol/L; 1 µmol/L = 0.0113 mg/dL |
| BUN | Blood Urea Nitrogen | Measures urea nitrogen in blood; reflects protein metabolism and kidney function | 5.0 | 200.0 | mg/dL | 1 mg/dL BUN = 0.357 mmol/L urea; 1 mmol/L urea = 2.8 mg/dL BUN |
| eGFR | Estimated Glomerular Filtration Rate | Calculated estimate of kidney filtration capacity; defines CKD staging | 0.0 | 150.0 | mL/min/1.73m² | Same in SI units |
| Cystatin_C | Cystatin C | Alternative GFR marker; less affected by muscle mass than creatinine | 0.4 | 10.0 | mg/L | Same in SI units (mg/L) |
| BUN_Creatinine_Ratio | BUN to Creatinine Ratio | Helps differentiate prerenal, renal, and postrenal azotemia | 5.0 | 50.0 | ratio | Dimensionless ratio; normal 10-20:1 |

## 2. Electrolytes (6 features)

| Key | Name | Description | Min | Max | Unit | Conversion |
|-----|------|-------------|-----|-----|------|------------|
| Sodium | Sodium | Major extracellular cation; regulates fluid balance and blood pressure | 110.0 | 170.0 | mEq/L | 1 mEq/L = 1 mmol/L (monovalent ion) |
| Potassium | Potassium | Major intracellular cation; critical for cardiac and muscle function; often elevated in CKD | 2.0 | 8.5 | mEq/L | 1 mEq/L = 1 mmol/L (monovalent ion) |
| Chloride | Chloride | Major extracellular anion; important for acid-base balance | 70.0 | 140.0 | mEq/L | 1 mEq/L = 1 mmol/L (monovalent ion) |
| Bicarbonate | Bicarbonate (CO2) | Primary blood buffer; often low in CKD due to metabolic acidosis | 5.0 | 40.0 | mEq/L | 1 mEq/L = 1 mmol/L |
| Anion_Gap | Anion Gap | Calculated value (Na - Cl - HCO3); helps classify metabolic acidosis | 0.0 | 40.0 | mEq/L | 1 mEq/L = 1 mmol/L |
| Magnesium | Magnesium | Essential mineral for enzyme function; levels vary in CKD | 0.5 | 10.0 | mg/dL | 1 mg/dL = 0.411 mmol/L; 1 mmol/L = 2.43 mg/dL; 1 mg/dL = 0.823 mEq/L |

## 3. Mineral & Bone Metabolism (7 features)

| Key | Name | Description | Min | Max | Unit | Conversion |
|-----|------|-------------|-----|-----|------|------------|
| Serum_Calcium | Serum Calcium (Total) | Total calcium including protein-bound; important for CKD-MBD management | 5.0 | 15.0 | mg/dL | 1 mg/dL = 0.25 mmol/L; 1 mmol/L = 4.0 mg/dL; 1 mg/dL = 0.5 mEq/L |
| Ionized_Calcium | Ionized Calcium | Physiologically active calcium fraction; more accurate in hypoalbuminemia | 0.8 | 2.0 | mmol/L | 1 mmol/L = 4.0 mg/dL; 1 mg/dL = 0.25 mmol/L |
| Phosphorus | Phosphorus (Inorganic Phosphate) | Often elevated in CKD; key target in CKD-MBD management | 1.0 | 15.0 | mg/dL | 1 mg/dL = 0.323 mmol/L; 1 mmol/L = 3.1 mg/dL |
| Intact_PTH | Intact Parathyroid Hormone | Regulates calcium/phosphorus; often elevated in CKD (secondary hyperparathyroidism) | 5.0 | 2500.0 | pg/mL | 1 pg/mL = 0.106 pmol/L; 1 pmol/L = 9.43 pg/mL |
| Vitamin_D_25OH | 25-Hydroxyvitamin D | Storage form of vitamin D; often deficient in CKD | 4.0 | 200.0 | ng/mL | 1 ng/mL = 2.496 nmol/L; 1 nmol/L = 0.4 ng/mL |
| Vitamin_D_1_25OH | 1,25-Dihydroxyvitamin D (Calcitriol) | Active form of vitamin D; produced by kidneys; decreased in CKD | 5.0 | 100.0 | pg/mL | 1 pg/mL = 2.6 pmol/L; 1 pmol/L = 0.385 pg/mL |
| Alkaline_Phosphatase | Alkaline Phosphatase | Enzyme from bone/liver; marker of bone turnover in CKD-MBD | 20.0 | 2000.0 | U/L | Same in SI units (U/L = IU/L) |

## 4. Hematology / CBC (5 features)

| Key | Name | Description | Min | Max | Unit | Conversion |
|-----|------|-------------|-----|-----|------|------------|
| Hemoglobin | Hemoglobin | Oxygen-carrying protein; often low in CKD due to reduced erythropoietin | 3.0 | 20.0 | g/dL | 1 g/dL = 10 g/L = 0.6206 mmol/L; 1 mmol/L = 1.611 g/dL |
| Hematocrit | Hematocrit | Percentage of blood volume occupied by red blood cells | 10.0 | 65.0 | % | % = L/L × 100; 1% = 0.01 L/L |
| RBC_Count | Red Blood Cell Count | Number of red blood cells per volume of blood | 1.5 | 7.0 | million/µL | 1 million/µL = 10^12/L = 1 × 10^6/µL |
| WBC_Count | White Blood Cell Count | Total leukocyte count; marker of infection/inflammation | 0.5 | 50.0 | ×10³/µL | 1 ×10³/µL = 10^9/L = 1000/µL |
| Platelet_Count | Platelet Count | Number of platelets; important for bleeding risk assessment | 10.0 | 1500.0 | ×10³/µL | 1 ×10³/µL = 10^9/L |

## 5. Iron Studies (5 features)

| Key | Name | Description | Min | Max | Unit | Conversion |
|-----|------|-------------|-----|-----|------|------------|
| Serum_Iron | Serum Iron | Circulating iron bound to transferrin | 10.0 | 300.0 | µg/dL | 1 µg/dL = 0.179 µmol/L; 1 µmol/L = 5.59 µg/dL |
| TIBC | Total Iron Binding Capacity | Indirect measure of transferrin; capacity to bind iron | 50.0 | 600.0 | µg/dL | 1 µg/dL = 0.179 µmol/L; 1 µmol/L = 5.59 µg/dL |
| Transferrin_Saturation | Transferrin Saturation (TSAT) | Percentage of transferrin bound to iron; key for ESA therapy in CKD | 0.0 | 100.0 | % | Calculated: (Serum Iron / TIBC) × 100 |
| Ferritin | Ferritin | Iron storage protein; target for anemia management in CKD | 5.0 | 5000.0 | ng/mL | 1 ng/mL = 1 µg/L = 2.247 pmol/L |
| Reticulocyte_Count | Reticulocyte Count | Immature red blood cells; indicates bone marrow response | 0.1 | 10.0 | % | Absolute count = % × RBC count |

## 6. Liver Function (2 features)

| Key | Name | Description | Min | Max | Unit | Conversion |
|-----|------|-------------|-----|-----|------|------------|
| Total_Bilirubin | Total Bilirubin | Breakdown product of hemoglobin; marker of liver function | 0.1 | 30.0 | mg/dL | 1 mg/dL = 17.1 µmol/L; 1 µmol/L = 0.058 mg/dL |
| Direct_Bilirubin | Direct (Conjugated) Bilirubin | Water-soluble bilirubin processed by liver | 0.0 | 15.0 | mg/dL | 1 mg/dL = 17.1 µmol/L; 1 µmol/L = 0.058 mg/dL |

## 7. Proteins / Nutrition (4 features)

| Key | Name | Description | Min | Max | Unit | Conversion |
|-----|------|-------------|-----|-----|------|------------|
| Albumin_Serum | Serum Albumin | Major plasma protein; marker of nutrition and inflammation in CKD | 1.0 | 6.5 | g/dL | 1 g/dL = 10 g/L; 1 g/L = 0.1 g/dL |
| Total_Protein | Total Protein | Sum of albumin and globulins in serum | 3.0 | 12.0 | g/dL | 1 g/dL = 10 g/L; 1 g/L = 0.1 g/dL |
| Prealbumin | Prealbumin (Transthyretin) | Short half-life protein; sensitive marker of nutritional status | 5.0 | 50.0 | mg/dL | 1 mg/dL = 10 mg/L; 1 mg/dL = 0.01 g/L |
| CRP | C-Reactive Protein | Acute phase reactant; marker of inflammation common in CKD | 0.0 | 50.0 | mg/L | 1 mg/L = 0.1 mg/dL; 1 mg/dL = 10 mg/L |

## 8. Lipid Panel (5 features)

| Key | Name | Description | Min | Max | Unit | Conversion |
|-----|------|-------------|-----|-----|------|------------|
| Total_Cholesterol | Total Cholesterol | Sum of all cholesterol fractions; cardiovascular risk marker | 50.0 | 500.0 | mg/dL | 1 mg/dL = 0.0259 mmol/L; 1 mmol/L = 38.67 mg/dL |
| LDL_Cholesterol | LDL Cholesterol | Low-density lipoprotein; primary target for CV risk reduction | 10.0 | 300.0 | mg/dL | 1 mg/dL = 0.0259 mmol/L; 1 mmol/L = 38.67 mg/dL |
| HDL_Cholesterol | HDL Cholesterol | High-density lipoprotein; "good" cholesterol | 10.0 | 150.0 | mg/dL | 1 mg/dL = 0.0259 mmol/L; 1 mmol/L = 38.67 mg/dL |
| Triglycerides | Triglycerides | Blood fat; often elevated in CKD and metabolic syndrome | 30.0 | 2000.0 | mg/dL | 1 mg/dL = 0.0113 mmol/L; 1 mmol/L = 88.5 mg/dL |
| Non_HDL_Cholesterol | Non-HDL Cholesterol | Total cholesterol minus HDL; includes all atherogenic particles | 30.0 | 400.0 | mg/dL | 1 mg/dL = 0.0259 mmol/L; 1 mmol/L = 38.67 mg/dL |

## 9. Glucose Metabolism (3 features)

| Key | Name | Description | Min | Max | Unit | Conversion |
|-----|------|-------------|-----|-----|------|------------|
| Glucose | Blood Glucose | Blood sugar level; diabetes is leading cause of CKD | 20.0 | 800.0 | mg/dL | 1 mg/dL = 0.0555 mmol/L; 1 mmol/L = 18.02 mg/dL |
| HbA1c | Hemoglobin A1c | Glycated hemoglobin; reflects 2-3 month glucose control (may be less reliable in CKD) | 3.0 | 20.0 | % | NGSP %: eAG (mg/dL) = 28.7 × A1c - 46.7; IFCC (mmol/mol) = (NGSP% - 2.15) × 10.929 |
| Fructosamine | Fructosamine | Glycated protein; reflects 2-3 week glucose control; useful when A1c unreliable | 150.0 | 600.0 | µmol/L | Same in SI units |

## 10. Uric Acid (1 feature)

| Key | Name | Description | Min | Max | Unit | Conversion |
|-----|------|-------------|-----|-----|------|------------|
| Uric_Acid | Uric Acid | Purine metabolism end product; often elevated in CKD; associated with gout | 1.0 | 20.0 | mg/dL | 1 mg/dL = 59.48 µmol/L; 1 µmol/L = 0.0168 mg/dL |

## 11. Urinalysis & Proteinuria (7 features)

| Key | Name | Description | Min | Max | Unit | Conversion |
|-----|------|-------------|-----|-----|------|------------|
| Urine_Albumin | Urine Albumin | Albumin in urine; early marker of kidney damage | 0.0 | 5000.0 | mg/L | 1 mg/L = 0.1 mg/dL; some labs use mg/24hr for timed collections |
| Urine_Creatinine | Urine Creatinine | Used to calculate protein/albumin ratios and assess collection adequacy | 10.0 | 500.0 | mg/dL | 1 mg/dL = 88.4 µmol/L; 1 mmol/L = 0.113 mg/dL |
| Albumin_to_Creatinine_Ratio_Urine | Urine Albumin-to-Creatinine Ratio (UACR) | Key marker for CKD staging and progression; spot urine test | 0.0 | 5000.0 | mg/g | 1 mg/g = 0.113 mg/mmol; 1 mg/mmol = 8.84 mg/g |
| Protein_to_Creatinine_Ratio_Urine | Urine Protein-to-Creatinine Ratio (UPCR) | Estimates 24-hour proteinuria from spot sample | 0.0 | 20000.0 | mg/g | 1 mg/g ≈ 1 mg/day protein; 1 mg/g = 0.113 mg/mmol |
| Urine_Protein | Urine Protein (Total) | Total protein in urine including albumin and other proteins | 0.0 | 3000.0 | mg/dL | 1 mg/dL = 10 mg/L; 24hr: mg/dL × volume (dL) = mg/24hr |
| Urine_pH | Urine pH | Acidity of urine; relevant for stone risk and acid-base status | 4.0 | 9.0 | pH units | Dimensionless; same globally |
| Urine_Specific_Gravity | Urine Specific Gravity | Concentration of urine; reflects hydration and concentrating ability | 1.000 | 1.040 | ratio | Dimensionless ratio; ~correlates with osmolality |

## 12. Cardiac Markers (4 features)

| Key | Name | Description | Min | Max | Unit | Conversion |
|-----|------|-------------|-----|-----|------|------------|
| BNP | B-type Natriuretic Peptide | Cardiac hormone; elevated in heart failure and volume overload (higher baseline in CKD) | 0.0 | 5000.0 | pg/mL | 1 pg/mL = 0.289 pmol/L; 1 pmol/L = 3.46 pg/mL |
| NT_proBNP | N-terminal pro-BNP | Inactive BNP fragment; more stable than BNP; elevated in CKD | 0.0 | 35000.0 | pg/mL | 1 pg/mL = 0.118 pmol/L; 1 pmol/L = 8.47 pg/mL |
| Troponin_I | Troponin I | Cardiac muscle protein; marker of myocardial injury (may be elevated in CKD) | 0.0 | 50.0 | ng/mL | 1 ng/mL = 1 µg/L = 1000 ng/L; 1 ng/L = 0.001 ng/mL |
| Troponin_T | Troponin T | Cardiac muscle protein; marker of myocardial injury (often elevated in ESRD) | 0.0 | 10.0 | ng/mL | 1 ng/mL = 1 µg/L = 1000 ng/L; 1 ng/L = 0.001 ng/mL |

## 13. Thyroid Function (2 features)

| Key | Name | Description | Min | Max | Unit | Conversion |
|-----|------|-------------|-----|-----|------|------------|
| Free_T4 | Free Thyroxine (T4) | Unbound active thyroid hormone | 0.2 | 6.0 | ng/dL | 1 ng/dL = 12.87 pmol/L; 1 pmol/L = 0.078 ng/dL |
| Free_T3 | Free Triiodothyronine (T3) | Most active thyroid hormone; may be low in sick euthyroid syndrome | 1.0 | 10.0 | pg/mL | 1 pg/mL = 1.536 pmol/L; 1 pmol/L = 0.651 pg/mL |

## 14. Blood Gases / Acid-Base (4 features)

| Key | Name | Description | Min | Max | Unit | Conversion |
|-----|------|-------------|-----|-----|------|------------|
| pH_Arterial | Arterial Blood pH | Blood acidity; often low in CKD due to metabolic acidosis | 6.8 | 7.8 | pH units | Dimensionless; same globally |
| pCO2_Arterial | Arterial pCO2 | Partial pressure of carbon dioxide; respiratory component of acid-base | 15.0 | 100.0 | mmHg | 1 mmHg = 0.133 kPa; 1 kPa = 7.5 mmHg |
| pO2_Arterial | Arterial pO2 | Partial pressure of oxygen; oxygenation status | 30.0 | 500.0 | mmHg | 1 mmHg = 0.133 kPa; 1 kPa = 7.5 mmHg |
| Lactate | Lactate | Anaerobic metabolism marker; elevated in hypoperfusion/sepsis | 0.3 | 20.0 | mmol/L | 1 mmol/L = 9.01 mg/dL; 1 mg/dL = 0.111 mmol/L |

## 15. Dialysis-Specific (2 features)

| Key | Name | Description | Min | Max | Unit | Conversion |
|-----|------|-------------|-----|-----|------|------------|
| Beta2_Microglobulin | Beta-2 Microglobulin | Middle molecule; accumulates in dialysis; associated with amyloidosis | 0.5 | 50.0 | mg/L | Same in SI units (mg/L) |
| Aluminum | Aluminum | Toxic metal; can accumulate in dialysis patients; causes bone disease | 0.0 | 200.0 | µg/L | 1 µg/L = 0.0371 µmol/L; 1 µmol/L = 26.98 µg/L |
