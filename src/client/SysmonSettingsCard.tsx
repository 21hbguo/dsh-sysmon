/**
 * The sysmon settings card: the enabled master switch and the collector cache
 * interval. Registers into the `settings.plugin.item` slot the plugin-
 * configuration section renders, bound to the `sysmon` settings namespace.
 */

import type { InjectFace, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { SettingsScope, SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import type { SysmonLocaleKey } from './locales.js'
import { PluginSettingsCard, BooleanField, ValueField } from './PluginSettingsCard.js'
import { CardForm, booleanField, numberField, type CardActions, type CardShell, type FieldState } from './settings-form.js'

/** The sysmon settings fields this card edits. */
export interface SysmonSettings {
  enabled?: boolean
  cacheMs?: number
}

/** What the sysmon settings card renders. */
export interface SysmonSettingsCardState extends CardShell {
  enabled: FieldState
  cacheMs: FieldState
}

/** The registration-side face the card's slot entry injects. */
export interface SysmonSettingsCardFace extends CardActions {
  hooks: {
    sysmonSettingsCard: SnapshotStore<SysmonSettingsCardState>
  }
}

/** Bridges the `sysmon` scope onto the card's staged form. */
export class SysmonSettingsCardController {
  private readonly form: CardForm<SysmonSettings>
  private readonly store: SnapshotStore<SysmonSettingsCardState>

  constructor(scope: SettingsScope<SysmonSettings>) {
    this.form = new CardForm(scope, [
      booleanField('enabled'),
      numberField('cacheMs', { min: 100 }),
    ])
    this.store = this.form.bind(() => this.projection())
  }

  private projection(): SysmonSettingsCardState {
    return {
      ...this.form.shell(),
      enabled: this.form.field('enabled'),
      cacheMs: this.form.field('cacheMs'),
    }
  }

  inject(): SysmonSettingsCardFace {
    return { hooks: { sysmonSettingsCard: this.store }, ...this.form.actions() }
  }
}

/** Props the renderer binds for the sysmon card. */
export type SysmonSettingsCardProps =
  PropsRuntime<'settings.plugin.item'>
  & { t: (key: SysmonLocaleKey & string) => string }
  & InjectFace<SysmonSettingsCardFace>

/** Render the sysmon settings card. */
export function SysmonSettingsCard(props: SysmonSettingsCardProps) {
  const { t } = props
  const state = props.useSysmonSettingsCard(snapshot => snapshot)
  const disabled = !state.writable
  const fieldProps = {
    overriddenLabel: t('settings.overridden'),
    resetLabel: t('settings.reset'),
    invalidLabel: t('settings.invalidNumber'),
    disabled,
  }
  return (
    <PluginSettingsCard
      t={t as (key: string) => string}
      titleKey="settings.title"
      descriptionKey="settings.description"
      state={state}
      onSave={props.save}
      onDiscard={props.discard}
    >
      <BooleanField
        id="settings-sysmon-enabled"
        label={t('settings.enabled')}
        hint={t('settings.enabledHint')}
        inheritLabel={t('settings.inherit')}
        onLabel={t('settings.on')}
        offLabel={t('settings.off')}
        {...fieldProps}
        {...state.enabled}
        onEdit={(text) => { props.edit('enabled', text) }}
        onReset={() => { props.resetField('enabled') }}
      />
      <ValueField
        id="settings-sysmon-cache"
        label={t('settings.cacheMs')}
        hint={t('settings.cacheMsHint')}
        numeric
        {...fieldProps}
        {...state.cacheMs}
        onEdit={(text) => { props.edit('cacheMs', text) }}
        onReset={() => { props.resetField('cacheMs') }}
      />
    </PluginSettingsCard>
  )
}
