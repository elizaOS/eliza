#!/bin/bash

echo "Testing function detection with various patterns..."

# Test 1: Regular function
echo "Test 1: Regular function"
echo 'function test() {
  console.log("test");
}' | awk '
BEGIN {
    brace_count = 0
    in_function = 0
    function_start = 0
    function_name = ""
}
/^(export\s+)?(async\s+)?function\s+\w+\s*\(/ ||
/^(export\s+)?(async\s+)?const\s+\w+\s*=\s*(async\s*)?\(/ ||
/^(export\s+)?(async\s+)?const\s+\w+\s*:\s*\w*\s*=\s*(async\s*)?\(/ ||
/^(export\s+)?(async\s+)?let\s+\w+\s*=\s*(async\s*)?\(/ ||
/^(export\s+)?(async\s+)?var\s+\w+\s*=\s*(async\s*)?\(/ ||
/^(export\s+)?(async\s+)?\w+\s*\([^)]*\)\s*[:=]\s*(async\s*)?\(/ ||
/^(export\s+)?(async\s+)?\w+\s*[:=]\s*(async\s*)?\([^)]*\)\s*[:=]\s*(async\s*)?\(/ {
    if (!in_function) {
        in_function = 1
        function_start = NR
        function_name = $0
        brace_count = 0
        # Count opening braces on this line
        gsub(/[^{]/, "", $0)
        brace_count += length($0)
        print "Function started at line " NR " with " brace_count " opening braces"
    }
    next
}
/{/ {
    if (in_function) {
        # Count opening braces on this line
        gsub(/[^{]/, "", $0)
        brace_count += length($0)
        print "Found opening brace, total: " brace_count
    }
}
/}/ {
    if (in_function) {
        # Count closing braces on this line
        gsub(/[^}]/, "", $0)
        brace_count -= length($0)
        print "Found closing brace, remaining: " brace_count
        if (brace_count <= 0) {
            function_length = NR - function_start + 1
            print "Function detected: " function_length " lines"
            in_function = 0
            function_start = 0
            function_name = ""
            brace_count = 0
        }
    }
}'

echo ""
echo "Test 2: Arrow function"
echo 'const test = () => {
  console.log("test");
}' | awk '
BEGIN {
    brace_count = 0
    in_function = 0
    function_start = 0
    function_name = ""
}
/^(export\s+)?(async\s+)?function\s+\w+\s*\(/ ||
/^(export\s+)?(async\s+)?const\s+\w+\s*=\s*(async\s*)?\(/ ||
/^(export\s+)?(async\s+)?const\s+\w+\s*:\s*\w*\s*=\s*(async\s*)?\(/ ||
/^(export\s+)?(async\s+)?let\s+\w+\s*=\s*(async\s*)?\(/ ||
/^(export\s+)?(async\s+)?var\s+\w+\s*=\s*(async\s*)?\(/ ||
/^(export\s+)?(async\s+)?\w+\s*\([^)]*\)\s*[:=]\s*(async\s*)?\(/ ||
/^(export\s+)?(async\s+)?\w+\s*[:=]\s*(async\s*)?\([^)]*\)\s*[:=]\s*(async\s*)?\(/ {
    if (!in_function) {
        in_function = 1
        function_start = NR
        function_name = $0
        brace_count = 0
        gsub(/[^{]/, "", $0)
        brace_count += length($0)
        print "Arrow function started at line " NR " with " brace_count " opening braces"
    }
    next
}
/{/ {
    if (in_function) {
        gsub(/[^{]/, "", $0)
        brace_count += length($0)
        print "Found opening brace, total: " brace_count
    }
}
/}/ {
    if (in_function) {
        gsub(/[^}]/, "", $0)
        brace_count -= length($0)
        print "Found closing brace, remaining: " brace_count
        if (brace_count <= 0) {
            function_length = NR - function_start + 1
            print "Function detected: " function_length " lines"
            in_function = 0
            function_start = 0
            function_name = ""
            brace_count = 0
        }
    }
}'

echo ""
echo "Test 3: Function with nested braces"
echo 'function test() {
  console.log("test");
  if (true) {
    console.log("nested");
    if (false) {
      console.log("more nested");
    }
  }
}' | awk '
BEGIN {
    brace_count = 0
    in_function = 0
    function_start = 0
    function_name = ""
}
/^(export\s+)?(async\s+)?function\s+\w+\s*\(/ ||
/^(export\s+)?(async\s+)?const\s+\w+\s*=\s*(async\s*)?\(/ ||
/^(export\s+)?(async\s+)?const\s+\w+\s*:\s*\w*\s*=\s*(async\s*)?\(/ ||
/^(export\s+)?(async\s+)?let\s+\w+\s*=\s*(async\s*)?\(/ ||
/^(export\s+)?(async\s+)?var\s+\w+\s*=\s*(async\s*)?\(/ ||
/^(export\s+)?(async\s+)?\w+\s*\([^)]*\)\s*[:=]\s*(async\s*)?\(/ ||
/^(export\s+)?(async\s+)?\w+\s*[:=]\s*(async\s*)?\([^)]*\)\s*[:=]\s*(async\s*)?\(/ {
    if (!in_function) {
        in_function = 1
        function_start = NR
        function_name = $0
        brace_count = 0
        gsub(/[^{]/, "", $0)
        brace_count += length($0)
        print "Function started at line " NR " with " brace_count " opening braces"
    }
    next
}
/{/ {
    if (in_function) {
        gsub(/[^{]/, "", $0)
        brace_count += length($0)
        print "Found opening brace, total: " brace_count
    }
}
/}/ {
    if (in_function) {
        gsub(/[^}]/, "", $0)
        brace_count -= length($0)
        print "Found closing brace, remaining: " brace_count
        if (brace_count <= 0) {
            function_length = NR - function_start + 1
            print "Function detected: " function_length " lines"
            in_function = 0
            function_start = 0
            function_name = ""
            brace_count = 0
        }
    }
}'

echo ""
echo "Test 4: Long function (>50 lines)"
long_function=$(for i in {1..55}; do echo "  console.log(\"line $i\");"; done)
echo "function longTest() {
$long_function
}" | awk '
BEGIN {
    brace_count = 0
    in_function = 0
    function_start = 0
    function_name = ""
}
/^(export\s+)?(async\s+)?function\s+\w+\s*\(/ ||
/^(export\s+)?(async\s+)?const\s+\w+\s*=\s*(async\s*)?\(/ ||
/^(export\s+)?(async\s+)?const\s+\w+\s*:\s*\w*\s*=\s*(async\s*)?\(/ ||
/^(export\s+)?(async\s+)?let\s+\w+\s*=\s*(async\s*)?\(/ ||
/^(export\s+)?(async\s+)?var\s+\w+\s*=\s*(async\s*)?\(/ ||
/^(export\s+)?(async\s+)?\w+\s*\([^)]*\)\s*[:=]\s*(async\s*)?\(/ ||
/^(export\s+)?(async\s+)?\w+\s*[:=]\s*(async\s*)?\([^)]*\)\s*[:=]\s*(async\s*)?\(/ {
    if (!in_function) {
        in_function = 1
        function_start = NR
        function_name = $0
        brace_count = 0
        gsub(/[^{]/, "", $0)
        brace_count += length($0)
        print "Long function started at line " NR " with " brace_count " opening braces"
    }
    next
}
/{/ {
    if (in_function) {
        gsub(/[^{]/, "", $0)
        brace_count += length($0)
    }
}
/}/ {
    if (in_function) {
        gsub(/[^}]/, "", $0)
        brace_count -= length($0)
        if (brace_count <= 0) {
            function_length = NR - function_start + 1
            if (function_length > 50) {
                print "LONG FUNCTION DETECTED: " function_length " lines"
            } else {
                print "Function detected: " function_length " lines"
            }
            in_function = 0
            function_start = 0
            function_name = ""
            brace_count = 0
        }
    }
}'

echo ""
echo "All tests completed!"