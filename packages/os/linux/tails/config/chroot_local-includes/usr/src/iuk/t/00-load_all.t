use Test::Most;

use Module::Pluggable::Object;

# libs
my @needsX;
my $finder = Module::Pluggable::Object->new(
    search_path => [ 'Tails' ],
);
foreach my $class (grep !/\.ToDo/,
                   sort do { local @INC = ('lib'); $finder->plugins }) {
  if (grep { $_ eq $class } @needsX) {
      next unless defined($ENV{DISPLAY}) && length($ENV{DISPLAY});
  }
  use_ok($class);
}

done_testing();
