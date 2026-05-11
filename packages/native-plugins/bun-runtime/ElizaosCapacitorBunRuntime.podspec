require 'json'

package = JSON.parse(File.read(File.join(__dir__, 'package.json')))

Pod::Spec.new do |s|
  s.name = 'ElizaosCapacitorBunRuntime'
  s.version = package['version']
  s.summary = package['description']
  s.license = package['license'] || { :type => 'MIT' }
  s.homepage = 'https://github.com/elizaOS'
  s.authors = { 'elizaOS' => 'shaw@elizalabs.ai' }
  s.source = { :git => 'https://github.com/elizaOS/eliza.git', :tag => s.version.to_s }
  s.source_files = 'ios/Sources/**/*.{swift,m,mm,h}'
  s.ios.deployment_target = '15.0'
  s.dependency 'Capacitor'
  s.frameworks = 'JavaScriptCore', 'Network', 'Accelerate', 'Metal', 'MetalKit', 'MetalPerformanceShaders', 'Foundation'
  s.swift_version = '5.9'

  # llama.cpp xcframework is built by
  # `native/ios-bun-port/vendor-deps/llama.cpp/build-ios.sh`. The build output
  # lives outside the npm package on purpose so it doesn't bloat publishes;
  # the operator runs the build script once and `pod install` picks it up.
  # If the xcframework is missing we still let CocoaPods install (so JS-side
  # work can proceed), but link-time symbol resolution will fail with a clear
  # "Undefined symbol _llama_*" error the developer can act on.
  llama_xcframework = File.expand_path(
    File.join(__dir__, '..', '..', '..', '..', 'native', 'ios-bun-port',
              'vendor-deps', 'llama.cpp', 'dist', 'LlamaCpp.xcframework')
  )
  if Dir.exist?(llama_xcframework)
    s.vendored_frameworks = llama_xcframework
  else
    warn "[ElizaosCapacitorBunRuntime] LlamaCpp.xcframework not found at #{llama_xcframework}; on-device inference will fail to link. Run native/ios-bun-port/vendor-deps/llama.cpp/build-ios.sh first."
  end

  s.pod_target_xcconfig = {
    'OTHER_LDFLAGS' => '$(inherited) -ObjC',
    'CLANG_CXX_LANGUAGE_STANDARD' => 'c++17',
    'CLANG_CXX_LIBRARY' => 'libc++'
  }
end
