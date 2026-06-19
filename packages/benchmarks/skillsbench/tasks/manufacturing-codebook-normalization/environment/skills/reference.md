Reference for Manufacturing Test Failure Reason Codebook Normalization

Factory test logs combine clean machine signals with messy human notes. The machines tell you what failed, but the engineers’ short free-text defect reason often contains the best clue about why it failed and what action was taken. These notes are usually written quickly on the production line and vary widely between engineers, shifts, and products.

In practice, engineer-written reasons are noisy and inconsistent. They often use unstandardized wording with missing key details, rely on ambiguous abbreviations or shop-floor slang, and mix multiple potential causes into a single sentence without clear structure. Typos in Chinese or English are common, as are inconsistent names for components, nets, fixtures, or stations. Even when an official codebook exists, on-site wording frequently drifts away from the standard, and across different products the same term may map to entirely different meanings or codes.

This makes the data difficult to reuse. Engineers who were not involved in the original failure may struggle to understand what actually happened, and analytics teams cannot reliably build Pareto charts or long-term trends because the same root cause appears under many slightly different texts.

A practical example from a factory test center might look like this:
- Raw reason: “OS NG / 换治具后OK, 可能虚焊+接触不良”
- Context: station = ICT, test_item = VDD_3V3, fail_code = OS
Here, “OS” likely refers to an Open/Short electrical failure rather than an operating system issue, “换治具后OK” points to a fixture or contact problem, and “虚焊+接触不良” mixes a manufacturing defect hypothesis with a test symptom. Without normalization, this single record could be counted as several unrelated failure types. With proper normalization, the text can be split into meaningful segments and mapped to standard codebook entries, enabling consistent root-cause tracking across lines, shifts, and products.


Reference Datasets and Papers
1. MIMII Dataset:
https://zenodo.org/record/3384388

2. SECOM dataset:
https://archive.ics.uci.edu/ml/datasets/SECOM

3. https://aclanthology.org/2020.coling-demos.2.pdf
