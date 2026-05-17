#!/usr/bin/env python3
"""
Verification script for WoocommerceStockAlertS2L environment setup.
Checks that all required files are present and properly configured.
"""

import sys
from pathlib import Path


def check_file_exists(file_path: Path, description: str) -> bool:
    """Check if a file exists and report"""
    exists = file_path.exists()
    status = "✓" if exists else "✗"
    print(f"   {status} {description}: {file_path.name}")
    return exists


def verify_setup():
    """Verify the environment setup"""
    print("=" * 80)
    print("WooCommerce Stock Alert S2L - Setup Verification")
    print("=" * 80)
    
    env_dir = Path(__file__).parent
    all_checks_passed = True
    
    # Check main files
    print("\n1. Main Environment Files:")
    main_files = [
        (env_dir / "woocommerce_stock_alert_s2l.py", "Main environment class"),
        (env_dir / "__init__.py", "Package initialization"),
        (env_dir / "README.md", "Documentation"),
        (env_dir / "IMPLEMENTATION_SUMMARY.md", "Implementation summary"),
    ]
    
    for file_path, description in main_files:
        if not check_file_exists(file_path, description):
            all_checks_passed = False
    
    # Check preprocessing files
    print("\n2. Preprocessing Files:")
    preprocess_dir = env_dir / "preprocess"
    preprocess_files = [
        (preprocess_dir / "main.py", "Main preprocessing script"),
        (preprocess_dir / "woocommerce_client.py", "WooCommerce client"),
        (preprocess_dir / "sync_woocommerce.py", "Sync utilities"),
        (preprocess_dir / "woocommerce_products.json", "Sample products"),
    ]
    
    for file_path, description in preprocess_files:
        if not check_file_exists(file_path, description):
            all_checks_passed = False
    
    # Check evaluation files
    print("\n3. Evaluation Files:")
    eval_dir = env_dir / "evaluation"
    eval_files = [
        (eval_dir / "main.py", "Main evaluation script"),
        (eval_dir / "evaluate_updated_stock_alert.py", "Stock alert evaluator"),
    ]
    
    for file_path, description in eval_files:
        if not check_file_exists(file_path, description):
            all_checks_passed = False
    
    # Check initial workspace files
    print("\n4. Initial Workspace Files:")
    workspace_dir = env_dir / "initial_workspace"
    workspace_files = [
        (workspace_dir / "admin_credentials.txt", "Admin credentials"),
        (workspace_dir / "purchasing_manager_email.txt", "Manager email"),
        (workspace_dir / "stock_alert_email_template.md", "Email template"),
    ]
    
    for file_path, description in workspace_files:
        if not check_file_exists(file_path, description):
            all_checks_passed = False
    
    # Check configuration files
    print("\n5. Configuration Files:")
    config_files = [
        (env_dir / "emails_config.json", "Email configuration"),
    ]
    
    for file_path, description in config_files:
        if not check_file_exists(file_path, description):
            all_checks_passed = False
    
    # Check test and example files
    print("\n6. Test and Example Files:")
    test_files = [
        (env_dir / "test_env.py", "Test script"),
        (env_dir / "example_usage.py", "Usage examples"),
    ]
    
    for file_path, description in test_files:
        if not check_file_exists(file_path, description):
            all_checks_passed = False
    
    # Check main class implementation
    print("\n7. Code Quality Checks:")
    main_class_file = env_dir / "woocommerce_stock_alert_s2l.py"
    
    if main_class_file.exists():
        with open(main_class_file, 'r', encoding='utf-8') as f:
            content = f.read()
            
        checks = [
            ("class WoocommerceStockAlertS2LEnv(Env):", "Main class defined"),
            ("def reset(", "Reset method implemented"),
            ("def step(", "Step method implemented"),
            ("def _get_instructions(", "Instructions method implemented"),
            ("def _setup_logging(", "Logging setup implemented"),
        ]
        
        for check_str, description in checks:
            found = check_str in content
            status = "✓" if found else "✗"
            print(f"   {status} {description}")
            if not found:
                all_checks_passed = False
    
    # Summary
    print("\n" + "=" * 80)
    if all_checks_passed:
        print("✅ All verification checks passed!")
        print("\nEnvironment is properly set up and ready to use.")
        return 0
    else:
        print("❌ Some verification checks failed!")
        print("\nPlease review the errors above and fix missing files.")
        return 1


def main():
    """Main entry point"""
    return verify_setup()


if __name__ == "__main__":
    sys.exit(main())


