-- Kamervragen-quiz: schema, beveiliging en publieke functies.
-- Uitvoeren in Supabase: SQL Editor > plak dit bestand > Run
-- (of: `supabase db push` met de Supabase CLI).
--
-- Privacy-uitgangspunt: bezoekers loggen niet in en er wordt NIETS per persoon
-- opgeslagen. Stemmen verhogen alleen een teller per vraag.

-- ---------------------------------------------------------------------------
-- Admins: alleen accounts in deze tabel mogen beheren.
-- ---------------------------------------------------------------------------
create table if not exists public.admins (
  user_id     uuid primary key references auth.users (id) on delete cascade,
  aangemaakt  timestamptz not null default now()
);

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  -- Admin = staat in de tabel admins. Heeft het account 2FA (TOTP) ingesteld,
  -- dan telt de sessie pas als admin na het invoeren van de 2FA-code (aal2).
  select exists (select 1 from public.admins where user_id = auth.uid())
     and (
       coalesce(auth.jwt() ->> 'aal', 'aal1') = 'aal2'
       or not exists (
         select 1 from auth.mfa_factors f
         where f.user_id = auth.uid() and f.status = 'verified'
       )
     );
$$;

-- ---------------------------------------------------------------------------
-- Vragen
-- ---------------------------------------------------------------------------
create table if not exists public.vragen (
  id                      uuid primary key default gen_random_uuid(),
  bron_id                 text unique,               -- Zaak-Id uit de open data van de Tweede Kamer
  nummer                  text,                      -- bv. 2026Z12345
  titel                   text not null,
  indieners               text[] not null default '{}',
  aan                     text,                      -- geadresseerde bewindspersoon
  datum                   date,
  link                    text,

  -- Ruwe brontekst (alleen zichtbaar voor admins)
  vraag_tekst             text,
  antwoord_tekst          text,
  antwoord_datum          date,

  -- Status
  status                  text not null default 'concept'
                          check (status in ('concept', 'gepubliceerd', 'afgewezen')),
  herzien_nodig           boolean not null default false,  -- bv. antwoord binnengekomen na publicatie

  -- Door admin gecontroleerde inhoud (wat de quiz toont)
  googlebaar              boolean,
  googlebaar_uitleg       text,
  bronnen                 jsonb not null default '[]'::jsonb,  -- [{ "titel": "...", "url": "https://..." }]
  beantwoord              boolean not null default false,
  vragen_samenvatting     text,
  antwoord_samenvatting   text,
  score                   smallint check (score between 1 and 10),
  score_uitleg            text,

  -- AI-concept (alleen ter referentie voor de admin)
  ai_concept              jsonb,
  ai_fout                 text,

  aangemaakt_op           timestamptz not null default now(),
  bijgewerkt_op           timestamptz not null default now(),
  gepubliceerd_op         timestamptz
);

create index if not exists vragen_status_idx on public.vragen (status);
create index if not exists vragen_datum_idx  on public.vragen (datum desc);

-- Controle bij publiceren: alles wat de quiz toont moet ingevuld zijn.
create or replace function public.vragen_controle()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.bijgewerkt_op := now();

  if new.status = 'gepubliceerd' then
    if new.googlebaar is null then
      raise exception 'Publiceren kan niet: kies of het antwoord googlebaar was.';
    end if;
    if coalesce(btrim(new.googlebaar_uitleg), '') = '' then
      raise exception 'Publiceren kan niet: de uitleg bij "googlebaar" ontbreekt.';
    end if;
    if new.score is null or coalesce(btrim(new.score_uitleg), '') = '' then
      raise exception 'Publiceren kan niet: score en uitleg bij de score zijn verplicht.';
    end if;
    if coalesce(btrim(new.vragen_samenvatting), '') = '' then
      raise exception 'Publiceren kan niet: de samenvatting van de vragen ontbreekt.';
    end if;
    if new.beantwoord and coalesce(btrim(new.antwoord_samenvatting), '') = '' then
      raise exception 'Publiceren kan niet: bij een beantwoorde vraag is de samenvatting van het antwoord verplicht.';
    end if;
    if jsonb_typeof(new.bronnen) <> 'array' then
      raise exception 'Bronnen moeten een lijst zijn.';
    end if;
    if tg_op = 'INSERT' or old.status is distinct from 'gepubliceerd' then
      new.gepubliceerd_op := now();
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists vragen_controle on public.vragen;
create trigger vragen_controle
  before insert or update on public.vragen
  for each row execute function public.vragen_controle();

-- ---------------------------------------------------------------------------
-- Anonieme totalen: alleen tellers, geen gegevens per persoon.
-- ---------------------------------------------------------------------------
create table if not exists public.totalen (
  vraag_id    uuid primary key references public.vragen (id) on delete cascade,
  google_ja   integer not null default 0,
  google_nee  integer not null default 0,
  slim        integer not null default 0,
  dom         integer not null default 0
);

-- ---------------------------------------------------------------------------
-- Beveiliging (Row Level Security)
-- Publiek (anon) mag NIETS direct lezen of schrijven; alleen via de functies
-- quiz_ronde() en stem() hieronder. Admins hebben volledige toegang.
-- ---------------------------------------------------------------------------
alter table public.admins  enable row level security;
alter table public.vragen  enable row level security;
alter table public.totalen enable row level security;

revoke all on public.admins, public.vragen, public.totalen from anon;
revoke all on public.admins, public.vragen, public.totalen from authenticated;
grant select on public.admins to authenticated;
grant select, insert, update, delete on public.vragen  to authenticated;
grant select, update, delete         on public.totalen to authenticated;

drop policy if exists "admin leest eigen rij" on public.admins;
create policy "admin leest eigen rij" on public.admins
  for select to authenticated using (user_id = auth.uid());

drop policy if exists "admins beheren vragen" on public.vragen;
create policy "admins beheren vragen" on public.vragen
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

drop policy if exists "admins beheren totalen" on public.totalen;
create policy "admins beheren totalen" on public.totalen
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

-- ---------------------------------------------------------------------------
-- Publieke functie: een quizronde met willekeurige gepubliceerde vragen.
-- Geeft alleen publieke velden terug (geen ruwe tekst, geen AI-concept).
-- ---------------------------------------------------------------------------
create or replace function public.quiz_ronde(aantal integer default 10)
returns table (
  id                    uuid,
  nummer                text,
  titel                 text,
  indieners             text[],
  aan                   text,
  datum                 date,
  link                  text,
  googlebaar            boolean,
  googlebaar_uitleg     text,
  bronnen               jsonb,
  beantwoord            boolean,
  vragen_samenvatting   text,
  antwoord_samenvatting text,
  score                 smallint,
  score_uitleg          text,
  google_ja             integer,
  google_nee            integer,
  slim                  integer,
  dom                   integer
)
language sql
volatile
security definer
set search_path = ''
as $$
  select v.id, v.nummer, v.titel, v.indieners, v.aan, v.datum, v.link,
         v.googlebaar, v.googlebaar_uitleg, v.bronnen, v.beantwoord,
         v.vragen_samenvatting,
         case when v.beantwoord then v.antwoord_samenvatting end,
         v.score, v.score_uitleg,
         coalesce(t.google_ja, 0), coalesce(t.google_nee, 0),
         coalesce(t.slim, 0), coalesce(t.dom, 0)
  from public.vragen v
  left join public.totalen t on t.vraag_id = v.id
  where v.status = 'gepubliceerd'
  order by random()
  limit greatest(1, least(coalesce(aantal, 10), 25));
$$;

-- ---------------------------------------------------------------------------
-- Publieke functie: anoniem stemmen. Verhoogt alleen een teller.
-- soort: 'google_ja' | 'google_nee' | 'slim' | 'dom'
-- ---------------------------------------------------------------------------
create or replace function public.stem(p_vraag uuid, p_soort text)
returns table (google_ja integer, google_nee integer, slim integer, dom integer)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_beantwoord boolean;
begin
  select v.beantwoord into v_beantwoord
  from public.vragen v
  where v.id = p_vraag and v.status = 'gepubliceerd';

  if not found then
    raise exception 'Onbekende vraag' using errcode = 'P0002';
  end if;
  if p_soort not in ('google_ja', 'google_nee', 'slim', 'dom') then
    raise exception 'Ongeldige stem' using errcode = '22023';
  end if;
  if p_soort in ('slim', 'dom') and not v_beantwoord then
    raise exception 'Op deze vraag kan nog niet slim/dom gestemd worden' using errcode = '22023';
  end if;

  insert into public.totalen as t (vraag_id, google_ja, google_nee, slim, dom)
  values (p_vraag,
          (p_soort = 'google_ja')::int, (p_soort = 'google_nee')::int,
          (p_soort = 'slim')::int,      (p_soort = 'dom')::int)
  on conflict (vraag_id) do update set
    google_ja  = t.google_ja  + (p_soort = 'google_ja')::int,
    google_nee = t.google_nee + (p_soort = 'google_nee')::int,
    slim       = t.slim       + (p_soort = 'slim')::int,
    dom        = t.dom        + (p_soort = 'dom')::int;

  return query
    select t.google_ja, t.google_nee, t.slim, t.dom
    from public.totalen t where t.vraag_id = p_vraag;
end;
$$;

revoke all on function public.quiz_ronde(integer) from public;
revoke all on function public.stem(uuid, text)    from public;
revoke all on function public.is_admin()          from public;
grant execute on function public.quiz_ronde(integer) to anon, authenticated;
grant execute on function public.stem(uuid, text)    to anon, authenticated;
grant execute on function public.is_admin()          to authenticated;
