use std::env;
use std::fs;
use std::path::PathBuf;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let out_dir = PathBuf::from(env::var("OUT_DIR")?);
    
    // Proto files are in the @schemas package, relative to this crate
    let schemas_dir = PathBuf::from("../@schemas");
    let proto_dir = schemas_dir.join("eliza/v1");
    
    // Check for bundled proto files (included in crates.io package)
    let bundled_proto_dir = PathBuf::from("proto/eliza/v1");
    
    let (proto_files, include_dir): (Vec<PathBuf>, PathBuf) = if bundled_proto_dir.exists() {
        // Use bundled protos (crates.io build)
        let files: Vec<PathBuf> = fs::read_dir(&bundled_proto_dir)?
            .filter_map(|entry| entry.ok())
            .map(|entry| entry.path())
            .filter(|path| path.extension().map_or(false, |ext| ext == "proto"))
            .collect();
        (files, PathBuf::from("proto"))
    } else if proto_dir.exists() {
        // Use workspace protos (local build)
        let files: Vec<PathBuf> = fs::read_dir(&proto_dir)?
            .filter_map(|entry| entry.ok())
            .map(|entry| entry.path())
            .filter(|path| path.extension().map_or(false, |ext| ext == "proto"))
            .collect();
        (files, schemas_dir.clone())
    } else {
        // No proto files available - create stub
        let stub = r#"
// Proto types stub - proto files not available during build
// This should not happen in a properly configured build

#[derive(Clone, PartialEq, ::prost::Message)]
pub struct Uuid {
    #[prost(string, tag = "1")]
    pub value: ::prost::alloc::string::String,
}

#[derive(Clone, PartialEq, ::prost::Message)]
pub struct DefaultUuid {}
"#;
        fs::write(out_dir.join("eliza.v1.rs"), stub)?;
        println!("cargo:warning=Proto files not found, using stub types");
        return Ok(());
    };
    
    if proto_files.is_empty() {
        println!("cargo:warning=No proto files found");
        return Ok(());
    }
    
    // Configure prost-build
    let mut config = prost_build::Config::new();
    config.out_dir(&out_dir);
    
    // Compile protos
    config.compile_protos(&proto_files, &[&include_dir])?;
    
    // Tell Cargo to rerun if proto files change
    for proto in &proto_files {
        println!("cargo:rerun-if-changed={}", proto.display());
    }
    println!("cargo:rerun-if-changed=build.rs");
    
    Ok(())
}
