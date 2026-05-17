use Test::Most;

use 5.10.1;
use strictures 2;
use lib qw{lib t/lib};

use Carp::Assert::More;
use File::Temp qw{tempdir tempfile};

my ($test_file_fh, $test_file_name) = tempfile;
say $test_file_fh "a" x 2**20;
close $test_file_fh;

use_ok('Tails::IUK::LWP::UserAgent::WithProgress');

my ($temp_fh, $temp_filename) = tempfile;
close $temp_fh;

my $ua  = Tails::IUK::LWP::UserAgent::WithProgress->new(
    {
        temp_file => $temp_filename,
        size      => 2**20,
    }
);
ok(defined $ua);

my $req = HTTP::Request->new('GET', "file:///$test_file_name");
assert_defined($req);

my $res = $ua->request($req, $temp_filename);

unlink $temp_filename;
unlink $test_file_name;

done_testing();
