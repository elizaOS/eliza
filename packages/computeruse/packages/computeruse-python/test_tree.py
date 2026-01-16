import sys
import os

# Add the target directory to the Python path so we can import computeruse
target_dir = os.path.join(os.path.dirname(__file__), "target", "debug")
if os.path.exists(target_dir):
    sys.path.insert(0, target_dir)

try:
    import computeruse
except ImportError as e:
    print(f"Could not import computeruse: {e}")
    print("Please build the Python bindings first using: maturin develop")
    sys.exit(1)


def count_elements(node):
    """Recursively count all elements in the tree."""
    count = 1  # Count this node
    if hasattr(node, "children") and node.children:
        for child in node.children:
            count += count_elements(child)
    return count


def display_tree(node, depth=0, max_depth=3):
    """Display tree structure with limited depth."""
    indent = "  " * depth
    attrs = node.attributes
    role = attrs.role
    name = attrs.name or "(no name)"

    print(f"{indent}{role}: {name}")

    if depth < max_depth and hasattr(node, "children") and node.children:
        print(f"{indent}  └─ {len(node.children)} children:")
        for child in node.children[:5]:  # Limit to first 5 children
            display_tree(child, depth + 1, max_depth)
        if len(node.children) > 5:
            print(f"{indent}     ... and {len(node.children) - 5} more")


def test_get_window_tree():
    try:
        # Create desktop instance
        print("Creating desktop instance...")
        desktop = computeruse.Desktop(False, False, "info")

        # Get list of applications to find a PID
        print("Getting list of applications...")
        apps = desktop.applications()

        if not apps:
            print("No applications found")
            return

        # Use the first application
        first_app = apps[0]
        pid = first_app.process_id()
        app_attrs = first_app.attributes()
        app_name = app_attrs.name or "Unknown App"

        print(f"Testing with application: {app_name} (PID: {pid})")

        # Create a custom config for fast tree building
        property_mode = computeruse.PropertyLoadingMode()
        property_mode.mode = "Fast"  # Can be "Fast", "Complete", or "Smart"

        config = computeruse.TreeBuildConfig()
        config.property_mode = property_mode
        config.timeout_per_operation_ms = 50
        config.yield_every_n_elements = 50
        config.batch_size = 50

        # Get the window tree with custom config
        print("Getting window tree with custom config...")
        tree = desktop.get_window_tree(pid, None, config)

        print("\nWindow Tree Structure:")
        display_tree(tree)

        print(f"\nTotal elements in tree: {count_elements(tree)}")

        # Also test without config (should use defaults)
        print("\n--- Testing without config (defaults) ---")
        default_tree = desktop.get_window_tree(pid)
        print(f"Total elements with default config: {count_elements(default_tree)}")

        # Test with different property modes
        print("\n--- Testing with Complete property mode ---")
        complete_mode = computeruse.PropertyLoadingMode()
        complete_mode.mode = "Complete"

        complete_config = computeruse.TreeBuildConfig()
        complete_config.property_mode = complete_mode

        complete_tree = desktop.get_window_tree(pid, None, complete_config)
        print(f"Total elements with Complete mode: {count_elements(complete_tree)}")

    except Exception as error:
        print(f"Error: {error}")
        import traceback

        traceback.print_exc()


if __name__ == "__main__":
    test_get_window_tree()
