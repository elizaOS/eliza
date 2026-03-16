require 'json'

package = JSON.parse(File.read(File.join(__dir__, 'package.json')))

Pod::Spec.new do |s|
  s.name = 'MilaidyCapacitorTalkMode'
  s.version = package['version']
  s.summary = package['description']
  s.license = package['license'] || 'MIT'
  s.homepage = package['repository']['url'] rescue 'https://milaidy.ai'
  s.author = package['author'] rescue 'Milaidy'
  s.source = { :git => package['repository']['url'] rescue '', :tag => s.version.to_s }
  s.source_files = 'ios/Sources/**/*.{swift,h,m,c,cc,mm,cpp}'
  s.ios.deployment_target = '13.0'
  s.dependency 'Capacitor'
  s.swift_version = '5.1'
  s.frameworks = 'AVFoundation', 'Speech'
end
