require 'json'

package = JSON.parse(File.read(File.join(__dir__, 'package.json')))

Pod::Spec.new do |s|
  s.name = 'ElizaosCapacitorLlama'
  s.version = package['version']
  s.summary = package['description']
  s.license = package['license'] || { :type => 'MIT' }
  s.homepage = 'https://elizaos.ai'
  s.authors = { 'elizaOS' => 'dev@elizaos.ai' }
  s.source = { :git => 'https://github.com/elizaOS/eliza.git', :tag => s.version.to_s }
  s.source_files = 'ios/Sources/**/*.{swift,h,m}'
  s.ios.deployment_target = '15.0'
  s.dependency 'Capacitor'
  s.swift_version = '5.9'
  # Metal is a transitive dep of llama.xcframework. Once the framework is
  # dropped into ios/Frameworks/ and linked, uncomment the vendored
  # frameworks line below and ship prebuilt binaries with the pod.
  # s.vendored_frameworks = 'ios/Frameworks/llama.xcframework'
  s.frameworks = 'Metal', 'MetalPerformanceShaders', 'Accelerate'
end
