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
  s.dependency 'LlamaCppCapacitor'
  s.frameworks = 'JavaScriptCore', 'Network', 'Accelerate', 'Metal', 'MetalKit', 'MetalPerformanceShaders', 'Foundation', 'LlamaCpp'
  s.libraries = 'c++', 'c++abi'
  s.swift_version = '5.9'

  s.pod_target_xcconfig = {
    'OTHER_LDFLAGS' => '$(inherited) -ObjC',
    'CLANG_CXX_LANGUAGE_STANDARD' => 'c++17',
    'CLANG_CXX_LIBRARY' => 'libc++'
  }
end
