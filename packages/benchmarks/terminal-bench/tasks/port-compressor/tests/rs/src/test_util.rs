pub fn pretty_print_test_name(name: &str) {
    println!("=== {} ===", name);
}

pub fn pretty_print_sub_test_name(name: &str) {
    println!("> {}", name);
}
