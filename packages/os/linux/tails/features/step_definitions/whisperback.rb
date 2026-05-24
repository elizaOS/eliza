def whisperback
  Dogtail::Application.new('whisperback')
end

Then(/^WhisperBack starts$/) do
  whisperback
end

Then(/^WhisperBack has debugging information$/) do
  matching = whisperback.children(roleName: 'text', showingOnly: false).select do |x|
    x&.text&.slice(1, 50)&.include?('=== content of /proc/cmdline ===')
  end
  assert(!matching.empty?,
         'Could not find debugging info in the WhisperBack window')
end
