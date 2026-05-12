mod coverage;

use anyhow::Result;
use clap::Parser;

fn main() -> Result<()> {
    dotenvy::dotenv().ok();

    let coverage_args = coverage::CoverageArgs::parse();
    let report = coverage::run(&coverage_args)?;
    println!("FINAL_SCORE={:.3}", report.final_score);
    Ok(())
}
