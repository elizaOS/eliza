from claw_eval.graders.webpage_grader import DynamicWebpageGrader


class MetroRoute2Grader(DynamicWebpageGrader):
    REFERENCE_IMAGE_PATH = "fixtures/地铁2.png"
    VISUAL_RUBRIC = (
        "Compare the animated metro route webpage against the reference metro map.\n"
        "CRITICAL: The underlying map must accurately match the reference, not just look like a generic subway map.\n"
        "- Does the metro map match the reference (correct lines, colors, stations)? (0.25)\n"
        "- Is the highlighted route clearly visible and distinct? (0.15)\n"
        "- Are station names along the route correct? (0.15)\n"
        "- Non-route lines appropriately dimmed/faded? (0.10)\n"
        "- Start and end stations clearly marked? (0.10)\n"
        "- Route description/info panel with correct station names? (0.10)\n"
        "- Clean, professional layout? (0.15)\n"
        "Score LOW if the map doesn't match the reference even though the UI looks nice."
    )
    PHYSICS_RUBRIC = (
        "Score the route animation across sequential frames ~0.5s apart:\n"
        "- Route highlight progresses along the path between frames? (0.30)\n"
        "- Stations along the route light up sequentially? (0.25)\n"
        "- Animation direction follows logical station order? (0.20)\n"
        "- Non-highlighted portions remain dimmed? (0.15)\n"
        "- Smooth visual progression between frames? (0.10)"
    )
