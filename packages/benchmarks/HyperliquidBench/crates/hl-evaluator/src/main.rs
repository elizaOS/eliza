mod coverage;
mod hian;

use anyhow::Result;
use clap::Parser;
use std::ffi::OsString;

fn main() -> Result<()> {
    dotenvy::dotenv().ok();

    let mut args: Vec<OsString> = std::env::args_os().collect();
    if args.get(1).is_some_and(|arg| arg == "hian") {
        args.remove(1);
        let hian_args = hian::HianArgs::parse_from(args);
        let report = hian::run(&hian_args)?;
        println!("{}", if report.result.pass { "PASS" } else { "FAIL" });
        println!(
            "eval_hian={}",
            report.out_dir.join("eval_hian.json").display()
        );
        return Ok(());
    }

    let coverage_args = coverage::CoverageArgs::parse();
    let report = coverage::run(&coverage_args)?;
    println!("FINAL_SCORE={:.3}", report.final_score);
    Ok(())
}
