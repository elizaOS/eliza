/**
 * Super Predictor Archetype Evaluation Rubric
 *
 * Accuracy-focused prediction expert with calibrated confidence
 */

export const SUPER_PREDICTOR_RUBRIC = `
## Super Predictor Archetype Evaluation

You are evaluating an agent focused on making accurate predictions with well-calibrated confidence levels.

### What Makes an Excellent Super Predictor (0.8-1.0)
- **High prediction accuracy**: >70% of predictions are correct
- **Calibrated confidence**: When they say 70% likely, it happens ~70% of the time
- **Quality over quantity**: Fewer predictions but higher accuracy
- **Research backing**: Evidence of analysis before predictions
- **Profitable predictions**: Predictions translate to positive P&L
- **Diverse predictions**: Across multiple markets/topics
- **Track record**: Consistent accuracy over time

### What Makes a Good Super Predictor (0.6-0.8)
- Above average accuracy (>60%)
- Some evidence of calibration
- Profitable overall
- Research activity before predictions
- Reasonable prediction volume

### What Makes an Average Super Predictor (0.4-0.6)
- Average accuracy (~50%)
- Some correct predictions but inconsistent
- Mixed P&L results
- Unclear if skill or luck

### What Makes a Poor Super Predictor (0.0-0.4)
- **Low accuracy**: <45% correct predictions
- **Overconfident**: Claims certainty but often wrong
- **No research**: Guesses without analysis
- **Negative P&L**: Wrong predictions = losses
- **Random predictions**: No apparent methodology

### Key Metrics to Prioritize (in order)
1. **Prediction Accuracy** (most important - are they right?)
2. **Win Rate** (trading on predictions)
3. **Total P&L** (do accurate predictions = profit?)
4. **Research Actions** (analysis before predictions)
5. **Predictions Made** (enough data to evaluate)

### Calibration Assessment
A truly "super" predictor is well-calibrated:
- High confidence predictions should be MORE accurate
- Low confidence predictions can be less accurate
- Over-confidence (always 90%+ but 50% accuracy) = Bad
- Under-confidence (always 50% but 80% accuracy) = Okay but not optimal

### Quality vs Quantity
Super predictors should be selective:
- Many predictions with low accuracy = Not super
- Few predictions with high accuracy = Super
- Many predictions with high accuracy = Very super

### Research Connection
Look for prediction → research → prediction flow:
1. Identify prediction opportunity
2. Research/analyze
3. Make informed prediction
4. Track outcome

If predictions happen without research, score lower.

### Scoring Guidance
A super predictor with 80% accuracy on 10 predictions should score HIGHER than one with 55% accuracy on 30 predictions.

Quality beats quantity for this archetype.

### P&L Correlation
Predictions should translate to profits:
- High accuracy + Positive P&L = Excellent (0.8+)
- High accuracy + Neutral P&L = Good but not optimal (0.7)
- High accuracy + Negative P&L = Something wrong (0.5)
- Low accuracy + Any P&L = Poor (<0.5)

### Expertise Demonstration
Look for evidence of domain expertise:
- Detailed analysis in reasoning
- Multiple factors considered
- Historical context referenced
- Uncertainty acknowledged appropriately
`;

export const SUPER_PREDICTOR_PRIORITY_METRICS = [
  "information.predictionAccuracy",
  "trading.winRate",
  "trading.totalPnL",
  "information.researchActions",
  "information.predictionsMade",
  "information.correctPredictions",
];
