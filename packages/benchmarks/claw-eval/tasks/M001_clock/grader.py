from claw_eval.graders.webpage_grader import DynamicWebpageGrader


class ClockGrader(DynamicWebpageGrader):
    VISUAL_RUBRIC = (
        "Score the generated clock webpage screenshots:\n"
        "- Circular clock face with clear border? (0.2)\n"
        "- Hour/minute/second hands visible and distinct? (0.2)\n"
        "- Tick marks and/or numbers 1-12 visible? (0.2)\n"
        "- Clean centered design? (0.2)\n"
        "- Colors consistent and well-chosen? (0.2)"
    )
    PHYSICS_RUBRIC = (
        "Score the clock animation across sequential frames captured ~0.5s apart:\n"
        "- Second hand moves between frames? (0.3)\n"
        "- Movement appears smooth and clockwise? (0.2)\n"
        "- Position changes consistent with ~0.5s intervals? (0.2)\n"
        "- Hour/minute hands relatively stationary over 5s? (0.15)\n"
        "- Clock shows a plausible time? (0.15)"
    )
