from claw_eval.graders.webpage_grader import DynamicWebpageGrader


class SolarSystemGrader(DynamicWebpageGrader):
    VISUAL_RUBRIC = (
        "Score the generated solar system webpage screenshots:\n"
        "- Sun visible at center, bright yellow/gold? (0.15)\n"
        "- At least 6 planets visible at different orbit distances? (0.20)\n"
        "- Orbit paths/circles shown? (0.15)\n"
        "- Planet labels visible? (0.15)\n"
        "- Saturn has a visible ring? (0.10)\n"
        "- Dark space background? (0.10)\n"
        "- Planets have distinct colors and proportional sizes? (0.15)"
    )
    PHYSICS_RUBRIC = (
        "Score the solar system animation across sequential frames ~0.5s apart:\n"
        "- Planets move along their orbits between frames? (0.30)\n"
        "- Inner planets move faster than outer planets? (0.25)\n"
        "- Movement follows circular/elliptical paths? (0.20)\n"
        "- Sun remains stationary at center? (0.15)\n"
        "- Animation appears smooth? (0.10)"
    )
