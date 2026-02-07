/// Example demonstrating how to measure element function performance
/// This is a simplified version of what the benchmarks do
use std::time::Instant;
use computeruse::Desktop;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    println!("Element Function Performance Example");
    println!("===================================");

    // Initialize desktop automation
    let start = Instant::now();
    let desktop = Desktop::new(false, false)?;
    println!("Desktop initialization: {:?}", start.elapsed());

    // Get root element
    let start = Instant::now();
    let root = desktop.root();
    println!("Get root element: {:?}", start.elapsed());

    // Benchmark element attributes
    let start = Instant::now();
    let attributes = root.attributes();
    println!("Get attributes: {:?}", start.elapsed());
    println!("  - Role: {}", attributes.role);
    if let Some(name) = &attributes.name {
        println!("  - Name: {name}");
    }

    // Benchmark element bounds
    let start = Instant::now();
    match root.bounds() {
        Ok(bounds) => {
            println!("Get bounds: {:?}", start.elapsed());
            println!("  - Bounds: {bounds:?}");
        }
        Err(e) => println!("Failed to get bounds: {e}"),
    }

    // Benchmark getting children
    let start = Instant::now();
    match root.children() {
        Ok(children) => {
            println!("Get children: {:?}", start.elapsed());
            println!("  - Child count: {}", children.len());

            // Benchmark iterating through children
            let start = Instant::now();
            let mut child_roles = Vec::new();
            for child in children.iter().take(10) {
                child_roles.push(child.role());
            }
            println!("Process 10 children: {:?}", start.elapsed());
            println!("  - Roles found: {child_roles:?}");
        }
        Err(e) => println!("Failed to get children: {e}"),
    }

    // Benchmark tree traversal (breadth-first, limited)
    let start = Instant::now();
    let mut queue = vec![root.clone()];
    let mut visited_count = 0;
    let max_nodes = 50;

    while let Some(element) = queue.pop() {
        visited_count += 1;
        if visited_count >= max_nodes {
            break;
        }

        if let Ok(children) = element.children() {
            // Limit children to prevent explosion
            for child in children.into_iter().take(5) {
                queue.push(child);
            }
        }
    }

    println!(
        "Tree traversal ({} nodes): {:?}",
        visited_count,
        start.elapsed()
    );

    // Benchmark serialization
    let start = Instant::now();
    let serializable = root.to_serializable();
    println!("Convert to serializable: {:?}", start.elapsed());

    let start = Instant::now();
    let json = serde_json::to_string(&serializable)?;
    println!("Serialize to JSON: {:?}", start.elapsed());
    println!("  - JSON length: {} characters", json.len());

    println!("\nTo run full benchmarks:");
    println!("  cargo bench --bench element_tree_benchmarks");
    println!("  cargo bench --bench tree_performance_benchmarks");

    Ok(())
}
