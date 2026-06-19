=head1 NAME

Tails::IUK::UpgradeDescriptionFile - describe and manipulate a Tails upgrade-description file

=cut

package Tails::IUK::UpgradeDescriptionFile;

no Moo::sification;
use Moo;
use MooX::HandlesVia;

use 5.10.1;
use strictures 2;

use autodie qw(:all);
use Carp;
use Carp::Assert;
use Carp::Assert::More;
use Data::Dumper;
use Dpkg::Version qw{version_compare};
use English qw{-no_match_vars};
use Function::Parameters;
use List::MoreUtils qw{any};
use List::Util qw{sum};
use Path::Tiny;
use Types::Standard qw{ArrayRef ClassName Maybe Str};
use YAML::Any;

use namespace::clean;


=head1 ATTRIBUTES

=cut

has "$_" => (
    required  => 1,
    is        => 'ro',
    isa       => Str,
    predicate => 1,
) for (qw{product_name initial_install_version build_target channel});

has product_version => (
    is        => 'ro',
    isa       => Maybe[Str],
    default   => sub { undef },
    predicate => 1,
);

has upgrades =>
    is          => 'lazy',
    isa         => ArrayRef,
    handles_via => 'Array',
    handles     => {
        count_upgrades => 'count',
        all_upgrades   => 'elements',
        add_upgrade    => 'push',
        empty_upgrades => 'clear',
    },
    predicate   => 1;

has upgrade_paths =>
    is          => 'lazy',
    isa         => ArrayRef,
    handles_via => 'Array',
    handles     => {
        count_upgrade_paths => 'count',
        all_upgrade_paths   => 'elements',
    };


=head1 CONSTRUCTORS AND BUILDERS

=cut

method _build_upgrades () { return [] }

method _build_upgrade_paths () {
    assert($self->has_product_version);
    assert_defined($self->product_version);
    my @upgrade_paths;
    foreach my $upgrade ($self->all_upgrades) {
        next unless exists $upgrade->{'upgrade-paths'};
        my @upgrade_paths_to_newer_version = grep {
            version_compare(
                $upgrade->{version},
                $self->product_version
            ) == 1;
        } @{$upgrade->{'upgrade-paths'}};
        foreach my $path (@upgrade_paths_to_newer_version) {
            foreach my $key (qw{type target-files}) {
                assert(exists  $path->{$key});
                assert(defined $path->{$key});
            }
            $path->{'details-url'}  = $upgrade->{'details-url'};
            $path->{'upgrade-type'} = $upgrade->{'type'};
            $path->{'version'}      = $upgrade->{'version'};
            $path->{'total-size'}   = sum(map { $_->{size} } @{$path->{'target-files'}});
            push @upgrade_paths, $path;
        }
    }
    return \@upgrade_paths;
}

fun new_from_text (ClassName $class,
                   Str :$text,
                   Maybe[Str] :$product_version = undef) {

    my $data = YAML::Any::Load($text);

    my %args;
    foreach my $key (qw{product-name initial-install-version channel build-target upgrades}) {
        next unless exists $data->{$key};
        my $attribute = $key; $attribute =~ s{-}{_}xmsg;
        $args{$attribute} = $data->{$key};
    }

    $class->new(%args, product_version => $product_version);
}

fun new_from_file (ClassName $class,
                   Str :$filename,
                   Maybe[Str] :$product_version = undef) {
    my $content = path($filename)->slurp;
    assert_nonblank($content);

    $class->new_from_text(text => $content, product_version => $product_version);
}


=head1 METHODS

=cut

method contains_upgrade_path () {
    $self->count_upgrade_paths > 0;
}

method incremental_upgrade_paths () {
    grep { $_->{type} eq 'incremental' } $self->all_upgrade_paths;
}

method full_upgrade_paths () {
    grep { $_->{type} eq 'full' } $self->all_upgrade_paths;
}

method contains_incremental_upgrade_path () {
    $self->incremental_upgrade_paths > 0;
}

method contains_full_upgrade_path () {
    $self->full_upgrade_paths > 0;
}

method incremental_upgrade_path () {
    path_to_newest_version($self->incremental_upgrade_paths);
}

method full_upgrade_path () {
    path_to_newest_version($self->full_upgrade_paths);
}

method stringify () {
    my %data;

    foreach my $attribute (qw{product_name initial_install_version channel build_target upgrades}) {
        my $predicate = "has_$attribute";
        next unless $self->$predicate;
        my $key = $attribute; $key =~ s{_}{-}xmsg;
        $data{$key} = $self->$attribute;
    }

    YAML::Any::Dump(\%data);
}


=head1 FUNCTIONS

=cut

fun path_to_newest_version (@paths) {
    assert(@paths);

    my $current_best_path = { version => '0' };

    foreach my $path (@paths) {
        $current_best_path = $path
            if version_compare($path->{version}, $current_best_path->{version}) == 1;
    }

    return $current_best_path;
}

no Moo;
1;
